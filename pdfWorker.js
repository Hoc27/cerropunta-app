// pdfWorker.js
const Shopify = require('shopify-api-node');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createWriteStream } = require('fs');
//const stream = require('stream');
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
async function getAllProducts(collectionId = '205283721384') {
  try {
    console.log(`Obteniendo productos de la colección ${collectionId}...`);
   
    let params = { 
      collection_id: collectionId,
      limit: 250 
    };
    let products = [];
    let hasNextPage = true;
   
    // Actualizar estado
    generationStatus.progress = 10;
    generationStatus.status = `Obteniendo productos de la colección ${collectionId}`;
   
    // Paginar a través de los productos de la colección
    while (hasNextPage) {
      // Utilizamos product.list con el parámetro collection_id
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
    console.log(`Se encontraron ${products.length} productos en la colección.`);
    return products;
  } catch (error) {
    console.error('Error al obtener productos de la colección:', error);
    generationStatus.error = `Error al obtener productos de la colección: ${error.message}`;
    throw error;
  }
}

// Función para generar el PDF con pdf-lib
async function generatePDF(products) {
  try {
    const outputPath = path.join(PUBLIC_DIR, 'productos_shopify.pdf');
    
    // Actualizar estado
    generationStatus.progress = 20;
    generationStatus.status = "Iniciando generación de PDF";
    
    // Número de productos por página
    const PRODUCTS_PER_BATCH = 8; // Solo 8 productos por batch (1 página)
    
    // Verificar el número total de páginas
    const totalPages = Math.ceil(products.length / PRODUCTS_PER_PAGE);
    const totalBatches = totalPages; // Cada página es un batch
    
    console.log(`Generando PDF con ${totalPages} páginas (${totalBatches} batches)...`);
    
    // Crear un documento PDF incremental - trabajar con un documento temporal
    // para cada lote y luego fusionarlos al final
    const tempPdfPaths = [];
    
    // Crear página de portada separada
    const coverPdfPath = path.join(PUBLIC_DIR, '_temp_cover.pdf');
    await createCoverPage(coverPdfPath);
    tempPdfPaths.push(coverPdfPath);
    
    // Procesar en lotes muy pequeños (solo 1 página a la vez)
    for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
      // Actualizar estado
      console.log(`Procesando página ${pageIndex + 1}/${totalPages}`);
      generationStatus.status = `Procesando página ${pageIndex + 1}/${totalPages}`;
      generationStatus.progress = 20 + Math.floor((pageIndex / totalPages) * 70);
      
      // Crear un nuevo documento para cada página
      const tempPdfPath = path.join(PUBLIC_DIR, `_temp_page_${pageIndex}.pdf`);
      
      // Generar la página individual
      await generateSinglePage(products, pageIndex, tempPdfPath);
      
      // Añadir a la lista de PDFs temporales
      tempPdfPaths.push(tempPdfPath);
      
      // Forzar garbage collection después de cada página si está disponible
      if (global.gc) {
        try {
          global.gc();
        } catch (err) {
          console.error('Error al ejecutar garbage collection:', err);
        }
      }
    }
    
    // Actualizar estado
    generationStatus.progress = 90;
    generationStatus.status = "Combinando páginas y finalizando PDF";
    
    // Combinar todos los PDFs temporales en uno solo
    await mergePDFs(tempPdfPaths, outputPath);
    
    // Limpiar archivos temporales
    try {
      for (const tempPath of tempPdfPaths) {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
          console.log(`Archivo temporal eliminado: ${tempPath}`);
        }
      }
    } catch (err) {
      console.error('Error al eliminar archivos temporales:', err);
    }
    
    console.log(`PDF generado exitosamente: ${outputPath}`);
    generationStatus.progress = 100;
    generationStatus.status = "Completado";
    
    return outputPath;
  } catch (error) {
    console.error('Error al generar PDF:', error);
    generationStatus.error = `Error al generar PDF: ${error.message}`;
    generationStatus.status = "Error";
    throw error;
  }
}

// Función para crear la página de portada
async function createCoverPage(outputPath) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  
  // Si existe la imagen de portada, usarla como fondo
  const COVER_IMAGE_PATH = path.join(__dirname, 'postada-cp-catalago.jpg');
  
  try {
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
        page.drawImage(coverImage, {
          x: 0,
          y: 0,
          width: PAGE_WIDTH,
          height: PAGE_HEIGHT,
        });
      }
    } else {
      // Agregar un título en la portada como alternativa
      page.drawText("Catálogo de Productos", {
        x: 150,
        y: PAGE_HEIGHT / 2,
        size: 24,
        font: helveticaBold
      });
    }
  } catch (error) {
    console.error("Error al cargar la imagen de portada:", error);
    // Continuar sin la portada en caso de error
    page.drawText("Catálogo de Productos", {
      x: 150,
      y: PAGE_HEIGHT / 2,
      size: 24,
      font: helveticaBold
    });
  }
  
  // Guardar la portada como PDF temporal
  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(outputPath, pdfBytes);
}

// Función para generar una sola página
async function generateSinglePage(products, pageIndex, outputPath) {
  try {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    
    // Fuentes necesarias
    const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    
    // Productos para esta página
    const startIdx = pageIndex * PRODUCTS_PER_PAGE;
    const endIdx = Math.min(startIdx + PRODUCTS_PER_PAGE, products.length);
    const pageProducts = products.slice(startIdx, endIdx);
    
    // Añadir número de página en el pie de página
    const totalPages = Math.ceil(products.length / PRODUCTS_PER_PAGE);
    page.drawText(`Página ${pageIndex + 1} de ${totalPages}`, {
      x: PAGE_WIDTH / 2 - 40,
      y: 30,
      font: helveticaFont,
      size: 8
    });
    
    // Proceso optimizado de carga de imágenes - una a la vez
    for (let i = 0; i < pageProducts.length; i++) {
      const product = pageProducts[i];
      const positionInPage = i % PRODUCTS_PER_PAGE;
      const col = positionInPage % 2;
      const row = Math.floor(positionInPage / 2);
      
      // Calcular posición X e Y
      const x = MARGIN + (col * COL_WIDTH);
      const y = PAGE_HEIGHT - MARGIN - 80 - (row * ROW_HEIGHT);
      
      // Cargar y procesar la imagen directamente, sin guardar referencias
      let productImage = null;
      
      if (product.image && product.image.src) {
        try {
          // Descargar imagen
          const localImagePath = await downloadImage(product.image.src, product.id);
          
          if (localImagePath && fs.existsSync(localImagePath)) {
            // Procesar imagen y limitar tamaño
            let imageBytes = fs.readFileSync(localImagePath);
            
            // Cargar imagen al PDF
            if (localImagePath.toLowerCase().endsWith('.jpg') || localImagePath.toLowerCase().endsWith('.jpeg')) {
              productImage = await pdfDoc.embedJpg(imageBytes);
            } else if (localImagePath.toLowerCase().endsWith('.png')) {
              productImage = await pdfDoc.embedPng(imageBytes);
            }
            
            // Dibujar imagen manteniendo la relación de aspecto
            if (productImage) {
              // Obtener las dimensiones originales de la imagen
              const imgWidth = productImage.width;
              const imgHeight = productImage.height;
              
              // Calcular la relación de aspecto
              const aspectRatio = imgWidth / imgHeight;
              
              // Calcular las nuevas dimensiones para mantener la relación de aspecto
              // mientras se ajusta al espacio máximo definido por IMAGE_SIZE
              let newWidth, newHeight;
              
              if (aspectRatio > 1) {
                // Imagen más ancha que alta
                newWidth = IMAGE_SIZE;
                newHeight = IMAGE_SIZE / aspectRatio;
              } else {
                // Imagen más alta que ancha o cuadrada
                newHeight = IMAGE_SIZE;
                newWidth = IMAGE_SIZE * aspectRatio;
              }
              
              // Calcular las coordenadas para centrar la imagen en el espacio disponible
              const centerX = x + (IMAGE_SIZE - newWidth) / 2;
              const centerY = y - newHeight - (IMAGE_SIZE - newHeight) / 2;
              
              // Dibujar la imagen con las dimensiones calculadas
              page.drawImage(productImage, {
                x: centerX,
                y: centerY,
                width: newWidth,
                height: newHeight,
              });
            }
            
            // Eliminar imagen temporal y liberar memoria
            if (fs.existsSync(localImagePath)) {
              fs.unlinkSync(localImagePath);
            }
            imageBytes = null;
            productImage = null;
          }
        } catch (error) {
          console.error(`Error al procesar imagen para producto ${product.id}:`, error.message);
          // Dibujar rectángulo como placeholder en caso de error
          drawPlaceholder(page, x, y, helveticaFont);
        }
      } else {
        // Dibujar rectángulo como placeholder para productos sin imagen
        drawPlaceholder(page, x, y, helveticaFont);
      }
      
      // Dibujar texto del producto
      const normalizedTitle = normalizeText(product.title || '');
      const titleLines = splitTextToLines(normalizedTitle, COL_WIDTH - IMAGE_SIZE - 15, helveticaBold, 9);
      const lineHeight = 12;
      
      titleLines.forEach((line, index) => {
        try {
          page.drawText(line, {
            x: x + IMAGE_SIZE + 10,
            y: y - 15 - (index * lineHeight),
            font: helveticaBold,
            size: 9,
            maxWidth: COL_WIDTH - IMAGE_SIZE - 15
          });
        } catch (error) {
          console.warn(`Error al dibujar texto "${line}": ${error.message}`);
        }
      });
      
      // Dibujar precio
      const titleHeight = titleLines.length * lineHeight;
      try {
        const priceText = `Precio: $${normalizeText(product.variants[0]?.price || 'N/A')}`;
        page.drawText(priceText, {
          x: x + IMAGE_SIZE + 10,
          y: y - 15 - titleHeight - 10,
          font: helveticaFont,
          size: 8,
          maxWidth: COL_WIDTH - IMAGE_SIZE - 15
        });
      } catch (error) {
        console.warn(`Error al dibujar precio: ${error.message}`);
      }
    }
    
    // Guardar página como PDF temporal
    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync(outputPath, pdfBytes);
    
    return outputPath;
  } catch (error) {
    console.error(`Error al generar página ${pageIndex + 1}:`, error);
    throw error;
  }
}

// Función para dibujar un placeholder para imágenes faltantes
function drawPlaceholder(page, x, y, font) {
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
    font: font,
    size: 8
  });
}

// Función para normalizar texto
function normalizeText(text) {
  if (!text) return '';
  
  // Normalizar caracteres acentuados y especiales
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Eliminar diacríticos
    .replace(/[^\x00-\x7F]/g, '') // Eliminar caracteres no ASCII
    .replace(/[^\w\s.,;:!?()\/\-"']/g, ''); // Mantener solo caracteres básicos
}

// Función para dividir texto en líneas
function splitTextToLines(text, maxWidth, font, fontSize) {
  if (!text) return [''];
  
  const words = text.split(' ');
  const lines = [];
  let currentLine = words[0] || '';
  
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    
    try {
      const width = font.widthOfTextAtSize(currentLine + ' ' + word, fontSize);
      
      if (width < maxWidth) {
        currentLine += ' ' + word;
      } else {
        lines.push(currentLine);
        currentLine = word;
      }
    } catch (error) {
      console.warn(`Error al medir texto "${currentLine} ${word}": ${error.message}`);
      currentLine += ' ' + word;
    }
  }
  
  lines.push(currentLine);
  return lines;
}

// Función para combinar múltiples PDFs en uno solo
async function mergePDFs(pdfPaths, outputPath) {
  try {
    const mergedPdf = await PDFDocument.create();
    
    for (const pdfPath of pdfPaths) {
      if (fs.existsSync(pdfPath)) {
        // Cargar PDF individual
        const pdfBytes = fs.readFileSync(pdfPath);
        const sourcePdf = await PDFDocument.load(pdfBytes); // Changed variable name from pdf to sourcePdf
        
        // Copiar todas las páginas al documento final
        const copiedPages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
        copiedPages.forEach(page => mergedPdf.addPage(page));
        
        // No intentar modificar la constante, solo liberar la referencia del contexto
        // sourcePdf = null;  <-- Esta línea causaba el error
      }
    }
    
    // Guardar el PDF combinado
    const mergedPdfBytes = await mergedPdf.save();
    fs.writeFileSync(outputPath, mergedPdfBytes);
    
    return outputPath;
  } catch (error) {
    console.error('Error al combinar PDFs:', error);
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