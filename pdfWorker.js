// pdfWorker.js
const Shopify = require('shopify-api-node');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createWriteStream } = require('fs');
const { promisify } = require('util');
const stream = require('stream');
const pipeline = promisify(stream.pipeline);
const dotenv = require('dotenv');

// Cargar variables de entorno
dotenv.config();

// Configuración de la API de Shopify
const shopify = new Shopify({
  shopName: process.env.SHOPIFY_SHOP_NAME,
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN
});

// Configuración para el documento PDF
const PRODUCTS_PER_PAGE = 8;
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 50;
const IMAGE_SIZE = 100;
const COL_WIDTH = (PAGE_WIDTH - MARGIN * 2) / 2;
const ROW_HEIGHT = 180;

// Archivo para almacenar la información de la última actualización
const LAST_UPDATE_FILE = path.join(__dirname, 'public', 'lastUpdate.json');
// Directorio para almacenar imágenes temporales
const TEMP_IMAGES_DIR = path.join(__dirname, 'temp_images');
// Asegurar que los directorios existen
const PUBLIC_DIR = path.join(__dirname, 'public');

// Asegurar que los directorios necesarios existen
if (!fs.existsSync(PUBLIC_DIR)) {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}
if (!fs.existsSync(TEMP_IMAGES_DIR)) {
  fs.mkdirSync(TEMP_IMAGES_DIR, { recursive: true });
}

// Estado de la generación
let generationStatus = {
  isGenerating: false,
  lastGenerated: null,
  error: null,
  progress: 0,
  totalProducts: 0
};

// Función para descargar una imagen y guardarla localmente
async function downloadImage(imageUrl, productId) {
  try {
    if (!imageUrl) return null;
    
    // Crear un nombre de archivo único basado en la URL
    const imageExtension = path.extname(new URL(imageUrl).pathname) || '.jpg';
    const localImagePath = path.join(TEMP_IMAGES_DIR, `product_${productId}${imageExtension}`);

    // Descargar la imagen
    const response = await axios({
      method: 'GET',
      url: imageUrl,
      responseType: 'stream'
    });

    // Guardar la imagen en disco
    await pipeline(response.data, createWriteStream(localImagePath));
    
    return localImagePath;
  } catch (error) {
    console.error(`Error al descargar imagen ${imageUrl}:`, error.message);
    return null;
  }
}

// Función para obtener todos los productos de Shopify
async function getAllProducts() {
  try {
    console.log('Obteniendo productos de Shopify...');
    
    let params = { limit: 250 };
    let products = [];
    let hasNextPage = true;
    
    // Actualizar estado
    generationStatus.progress = 10;
    generationStatus.status = "Obteniendo productos de Shopify";
    
    // Paginar a través de todos los productos
    while (hasNextPage) {
      const productBatch = await shopify.product.list(params);
      products = products.concat(productBatch);
      
      if (productBatch.length < 250) {
        hasNextPage = false;
      } else {
        params.page_info = productBatch.nextPageParameters?.page_info;
        params.limit = 250;
      }
    }
    
    generationStatus.totalProducts = products.length;
    console.log(`Se encontraron ${products.length} productos.`);
    return products;
  } catch (error) {
    console.error('Error al obtener productos:', error);
    generationStatus.error = `Error al obtener productos: ${error.message}`;
    throw error;
  }
}

// Función para generar el PDF con pdf-lib
async function generatePDF(products) {
  try {
    const outputPath = path.join(PUBLIC_DIR, 'productos_shopify.pdf');
    const pdfDoc = await PDFDocument.create();
    
    // Actualizar estado
    generationStatus.progress = 20;
    generationStatus.status = "Iniciando generación de PDF";
    
    // Fuentes
    const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    
    // Si existe la imagen de portada, usarla como fondo
    const COVER_IMAGE_PATH = path.join(__dirname, 'postada-cp-catalago.jpg');
    
    try {
      // Añadir página de portada
      const coverPage = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      
      if (fs.existsSync(COVER_IMAGE_PATH)) {
        const coverImageBytes = fs.readFileSync(COVER_IMAGE_PATH);
        let coverImage;
        
        // Determinar tipo de imagen y cargarla
        if (COVER_IMAGE_PATH.toLowerCase().endsWith('.jpg') || COVER_IMAGE_PATH.toLowerCase().endsWith('.jpeg')) {
          coverImage = await pdfDoc.embedJpg(coverImageBytes);
        } else if (COVER_IMAGE_PATH.toLowerCase().endsWith('.png')) {
          coverImage = await pdfDoc.embedPng(coverImageBytes);
        }
        
        if (coverImage) {
          coverPage.drawImage(coverImage, {
            x: 0,
            y: 0,
            width: PAGE_WIDTH,
            height: PAGE_HEIGHT,
          });
        }
      } else {
        console.log(`Archivo de portada no encontrado: ${COVER_IMAGE_PATH}. Continuando sin portada.`);
        // Agregar un título en la portada como alternativa
        coverPage.drawText("Catálogo de Productos", {
          x: 150,
          y: PAGE_HEIGHT / 2,
          size: 24,
          font: helveticaBold
        });
      }
    } catch (error) {
      console.error("Error al cargar la imagen de portada:", error);
      // Continuar sin la portada en caso de error
    }

    // Calcular número de páginas necesarias
    const totalPages = Math.ceil(products.length / PRODUCTS_PER_PAGE);
    console.log(`Generando PDF con ${totalPages} páginas...`);
    
    // Descargar todas las imágenes primero
    console.log('Descargando imágenes de productos...');
    const productImages = {};
    
    // Actualizar estado
    generationStatus.progress = 30;
    generationStatus.status = "Descargando imágenes de productos";
    
    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      if (product.image && product.image.src) {
        const localImagePath = await downloadImage(product.image.src, product.id);
        if (localImagePath) {
          productImages[product.id] = localImagePath;
        }
      }
      
      // Actualizar progreso de descarga de imágenes (del 30% al 60%)
      const downloadProgress = 30 + Math.floor((i / products.length) * 30);
      generationStatus.progress = downloadProgress;
    }
    
    console.log(`Descargadas ${Object.keys(productImages).length} imágenes de productos.`);
    
    // Crear páginas para productos
    const embeddedImages = {};
    
    // Actualizar estado
    generationStatus.progress = 60;
    generationStatus.status = "Procesando imágenes para el PDF";
    
    // Preparar todas las imágenes
    for (const productId in productImages) {
      const localImagePath = productImages[productId];
      
      if (fs.existsSync(localImagePath)) {
        try {
          const imageBytes = fs.readFileSync(localImagePath);
          
          if (localImagePath.toLowerCase().endsWith('.jpg') || localImagePath.toLowerCase().endsWith('.jpeg')) {
            embeddedImages[productId] = await pdfDoc.embedJpg(imageBytes);
          } else if (localImagePath.toLowerCase().endsWith('.png')) {
            embeddedImages[productId] = await pdfDoc.embedPng(imageBytes);
          }
        } catch (err) {
          console.error(`Error al cargar imagen para el producto ${productId}:`, err.message);
        }
      }
    }
    
    // Actualizar estado
    generationStatus.progress = 70;
    generationStatus.status = "Componiendo páginas del PDF";
    
    // Función auxiliar para dividir el texto en múltiples líneas
    function splitTextToLines(text, maxWidth, font, fontSize) {
      if (!text) return [''];
      
      const words = text.split(' ');
      const lines = [];
      let currentLine = words[0];
      
      for (let i = 1; i < words.length; i++) {
        const word = words[i];
        const width = font.widthOfTextAtSize(currentLine + ' ' + word, fontSize);
        
        if (width < maxWidth) {
          currentLine += ' ' + word;
        } else {
          lines.push(currentLine);
          currentLine = word;
        }
      }
      
      lines.push(currentLine);
      return lines;
    }
    
    // Organizar productos en páginas
    for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
      const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      
      // Actualizar progreso por página (del 70% al 90%)
      const pagesProgress = 70 + Math.floor((pageIndex / totalPages) * 20);
      generationStatus.progress = pagesProgress;
      
      // Añadir número de página en el pie de página
      page.drawText(`Página ${pageIndex + 1} de ${totalPages}`, {
        x: PAGE_WIDTH / 2 - 40,
        y: 30,
        font: helveticaFont,
        size: 8
      });
      
      // Productos para esta página
      const startIdx = pageIndex * PRODUCTS_PER_PAGE;
      const endIdx = Math.min(startIdx + PRODUCTS_PER_PAGE, products.length);
      
      for (let i = startIdx; i < endIdx; i++) {
        const product = products[i];
        const positionInPage = i % PRODUCTS_PER_PAGE;
        const col = positionInPage % 2;
        const row = Math.floor(positionInPage / 2);
        
        // Calcular posición X e Y
        const x = MARGIN + (col * COL_WIDTH);
        const y = PAGE_HEIGHT - MARGIN - 80 - (row * ROW_HEIGHT);
        
        // Dibujar imagen del producto
        if (embeddedImages[product.id]) {
          const productImage = embeddedImages[product.id];
          const imageDims = productImage.scale(1);
          const scale = Math.min(
            IMAGE_SIZE / imageDims.width,
            IMAGE_SIZE / imageDims.height
          );
          
          page.drawImage(productImage, {
            x: x,
            y: y - IMAGE_SIZE,
            width: IMAGE_SIZE,
            height: IMAGE_SIZE,
          });
        } else {
          // Rectángulo como placeholder para imágenes faltantes
          page.drawRectangle({
            x: x,
            y: y - IMAGE_SIZE,
            width: IMAGE_SIZE,
            height: IMAGE_SIZE,
            borderColor: rgb(0, 0, 0),
            borderWidth: 1,
          });
          
          page.drawText('Sin imagen', {
            x: x + 25,
            y: y - (IMAGE_SIZE / 2),
            font: helveticaFont,
            size: 8
          });
        }
        
        const titleLines = splitTextToLines(product.title, COL_WIDTH - IMAGE_SIZE - 15, helveticaBold, 9);
        const lineHeight = 12;
        
        titleLines.forEach((line, index) => {
          page.drawText(line, {
            x: x + IMAGE_SIZE + 10,
            y: y - 15 - (index * lineHeight),
            font: helveticaBold,
            size: 9,
            maxWidth: COL_WIDTH - IMAGE_SIZE - 15
          });
        });
        
        // Ajustar la posición del precio basado en la cantidad de líneas del título
        const titleHeight = titleLines.length * lineHeight;
        page.drawText(`Precio: $${product.variants[0]?.price || 'N/A'}`, {
          x: x + IMAGE_SIZE + 10,
          y: y - 15 - titleHeight - 10,
          font: helveticaFont,
          size: 8,
          maxWidth: COL_WIDTH - IMAGE_SIZE - 15
        });
      }
    }
    
    // Actualizar estado
    generationStatus.progress = 90;
    generationStatus.status = "Guardando PDF";
    
    // Guardar el PDF
    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync(outputPath, pdfBytes);
    
    console.log(`PDF generado exitosamente: ${outputPath}`);
    generationStatus.progress = 95;
    
    // Limpiar imágenes temporales después de generar el PDF
    try {
      console.log('Limpiando imágenes temporales...');
      Object.values(productImages).forEach(imagePath => {
        if (fs.existsSync(imagePath)) {
          fs.unlinkSync(imagePath);
        }
      });
      generationStatus.progress = 100;
      generationStatus.status = "Completado";
    } catch (err) {
      console.error('Error al limpiar imágenes temporales:', err);
    }
    
    return outputPath;
  } catch (error) {
    console.error('Error al generar PDF:', error);
    generationStatus.error = `Error al generar PDF: ${error.message}`;
    generationStatus.status = "Error";
    throw error;
  }
}

// Función para guardar la información de la última actualización
function saveLastUpdateInfo(productCount) {
  const updateInfo = {
    lastUpdateTime: new Date().toISOString(),
    productCount: productCount
  };
  
  fs.writeFileSync(LAST_UPDATE_FILE, JSON.stringify(updateInfo, null, 2));
  console.log(`Información de actualización guardada: ${productCount} productos.`);
}

// Función para cargar la información de la última actualización
function loadLastUpdateInfo() {
  try {
    if (fs.existsSync(LAST_UPDATE_FILE)) {
      const data = fs.readFileSync(LAST_UPDATE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error al cargar información de última actualización:', error);
  }
  
  // Si no hay archivo o hay error, devolver valores predeterminados
  return { lastUpdateTime: null, productCount: 0 };
}

// Función principal que obtiene productos y genera el PDF
async function updateProductsPDF() {
  if (generationStatus.isGenerating) {
    console.log('Ya hay una generación en curso. Ignorando solicitud.');
    return { 
      status: 'in_progress', 
      message: 'Ya hay una generación de PDF en curso' 
    };
  }
  
  try {
    console.log('Iniciando generación de catálogo...');
    
    // Marcar como en proceso
    generationStatus = {
      isGenerating: true,
      lastGenerated: null,
      error: null,
      progress: 0,
      status: "Iniciando"
    };
    
    // Obtener todos los productos
    const products = await getAllProducts();
    
    // Cargar información de la última actualización
    const lastUpdate = loadLastUpdateInfo();
    
    // Si hay productos, generar PDF
    if (products.length > 0) {
      // Generar nuevo PDF
      const pdfPath = await generatePDF(products);
      console.log(`Se generó un nuevo catálogo. PDF guardado en: ${pdfPath}`);
      
      // Guardar la nueva información de actualización
      saveLastUpdateInfo(products.length);
      
      generationStatus.isGenerating = false;
      generationStatus.lastGenerated = new Date().toISOString();
      generationStatus.progress = 100;
      generationStatus.status = "Completado";
      
      return { 
        status: 'success', 
        pdfPath, 
        productCount: products.length 
      };
    } else {
      console.log('No se encontraron productos.');
      
      generationStatus.isGenerating = false;
      generationStatus.error = "No se encontraron productos";
      generationStatus.status = "Error";
      
      return { 
        status: 'error', 
        message: 'No se encontraron productos' 
      };
    }
  } catch (error) {
    console.error('Error en la generación del PDF:', error);
    
    generationStatus.isGenerating = false;
    generationStatus.error = error.message;
    generationStatus.status = "Error";
    
    return { 
      status: 'error', 
      message: error.message 
    };
  }
}

// Función para obtener el estado actual de la generación
function getGenerationStatus() {
  return { ...generationStatus };
}

// Exportar funciones para ser usadas desde el servidor principal
module.exports = {
  updateProductsPDF,
  getGenerationStatus
};

// Si este archivo se ejecuta directamente, generar el PDF
if (require.main === module) {
  updateProductsPDF().then(result => {
    console.log('Resultado de la generación:', result);
    process.exit(0);
  }).catch(err => {
    console.error('Error fatal en la generación del PDF:', err);
    process.exit(1);
  });
}