const Shopify = require('shopify-api-node');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fs = require('fs');
const cron = require('node-cron');
const dotenv = require('dotenv');
const path = require('path');
const axios = require('axios');
const { createWriteStream } = require('fs');
const { promisify } = require('util');
const stream = require('stream');
const pipeline = promisify(stream.pipeline);
const cors = require('cors');
const express = require('express');
const app = express();

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
const LAST_UPDATE_FILE = path.join(__dirname, 'lastUpdate.json');
// Directorio para almacenar imágenes temporales
const TEMP_IMAGES_DIR = path.join(__dirname, 'temp_images');

// Asegurar que el directorio temporal existe
if (!fs.existsSync(TEMP_IMAGES_DIR)) {
  fs.mkdirSync(TEMP_IMAGES_DIR, { recursive: true });
}

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
    
    // Paginar a través de todos los productos (incluyendo borrador y publicados)
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
    
    console.log(`Se encontraron ${products.length} productos.`);
    return products;
  } catch (error) {
    console.error('Error al obtener productos:', error);
    throw error;
  }
}

// Función para generar el PDF con pdf-lib
async function generatePDF(products) {
  try {
    const outputPath = `./public/productos_shopify.pdf`;
    const pdfDoc = await PDFDocument.create();
    
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
          const imageDims = coverImage.scale(1);
          const scale = Math.max(
            PAGE_WIDTH / imageDims.width,
            PAGE_HEIGHT / imageDims.height
          );
          
          coverPage.drawImage(coverImage, {
            x: 0,
            y: 0,
            width: PAGE_WIDTH,
            height: PAGE_HEIGHT,
          });
        }
      } else {
        console.log(`Archivo de portada no encontrado: ${COVER_IMAGE_PATH}`);
      }
    } catch (error) {
      console.error("Error al cargar la imagen de portada:", error);
    }

    // Calcular número de páginas necesarias
    const totalPages = Math.ceil(products.length / PRODUCTS_PER_PAGE);
    console.log(`Generando PDF con ${totalPages} páginas...`);
    
    // Descargar todas las imágenes primero
    console.log('Descargando imágenes de productos...');
    const productImages = {};
    
    for (const product of products) {
      if (product.image && product.image.src) {
        const localImagePath = await downloadImage(product.image.src, product.id);
        if (localImagePath) {
          productImages[product.id] = localImagePath;
        }
      }
    }
    console.log(`Descargadas ${Object.keys(productImages).length} imágenes de productos.`);
    
    // Crear páginas para productos
    const embeddedImages = {};
    
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
    
    // Organizar productos en páginas
    for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
      const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      
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
        
        const titleLines = splitTextToLines(product.title, COL_WIDTH - IMAGE_SIZE - 15, helveticaBold, 9); // Tamaño reducido a 9
        const lineHeight = 12; // Espacio reducido entre líneas
        
        titleLines.forEach((line, index) => {
          page.drawText(line, {
            x: x + IMAGE_SIZE + 10,
            y: y - 15 - (index * lineHeight), // Espaciado entre líneas reducido
            font: helveticaBold,
            size: 9, // Tamaño reducido
            maxWidth: COL_WIDTH - IMAGE_SIZE - 15
          });
        });
        
        // Ajustar la posición del precio basado en la cantidad de líneas del título
        const titleHeight = titleLines.length * lineHeight;
        page.drawText(`Precio: $${product.variants[0]?.price || 'N/A'}`, {
          x: x + IMAGE_SIZE + 10,
          y: y - 15 - titleHeight - 10, // 10px de separación adicional después del título
          font: helveticaFont,
          size: 8,
          maxWidth: COL_WIDTH - IMAGE_SIZE - 15
        });
        
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
      }
    }
    
    // Guardar el PDF
    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync(outputPath, pdfBytes);
    
    console.log(`PDF generado exitosamente: ${outputPath}`);
    
    // Limpiar imágenes temporales después de generar el PDF
    try {
      console.log('Limpiando imágenes temporales...');
      Object.values(productImages).forEach(imagePath => {
        if (fs.existsSync(imagePath)) {
          fs.unlinkSync(imagePath);
        }
      });
    } catch (err) {
      console.error('Error al limpiar imágenes temporales:', err);
    }
    
    return outputPath;
  } catch (error) {
    console.error('Error al generar PDF:', error);
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
  try {
    console.log('Iniciando verificación de cambios en productos...');
    
    // Obtener todos los productos
    const products = await getAllProducts();
    
    // Cargar información de la última actualización
    const lastUpdate = loadLastUpdateInfo();
    
    // Si hay productos, verificar si ha cambiado la cantidad
    if (products.length > 0) {
      if (products.length !== lastUpdate.productCount) {
        console.log(`Se detectó un cambio en la cantidad de productos: ${lastUpdate.productCount} -> ${products.length}`);
        
        // Generar nuevo PDF
        const pdfPath = await generatePDF(products);
        console.log(`Se generó un nuevo catálogo debido al cambio en la cantidad de productos. PDF guardado en: ${pdfPath}`);
        
        // Guardar la nueva información de actualización
        saveLastUpdateInfo(products.length);
      } else {
        console.log(`No hay cambios en la cantidad de productos (${products.length}). No se generará un nuevo PDF.`);
      }
    } else {
      console.log('No se encontraron productos.');
      
      // Si antes había productos pero ahora no, actualizar información
      if (lastUpdate.productCount > 0) {
        console.log('Se detectó que todos los productos fueron eliminados.');
        saveLastUpdateInfo(0);
      }
    }
  } catch (error) {
    console.error('Error en la verificación de cambios:', error);
  }
}

const whitelist = ['https://superdd-app.myshopify.com', 'https://dominio2.com'];
const corsOptions = {
  origin: function (origin, callback) {
    if (whitelist.indexOf(origin) !== -1 || !origin) {
      callback(null, true);
    } else {
      callback(new Error('Bloqueado por CORS'));
    }
  }
};
app.use(cors(corsOptions));
// Función para iniciar la aplicación
function startApp() {
  console.log('Iniciando aplicación de generación de catálogo de Shopify...');
  
  // Crear directorio public si no existe
  const publicDir = path.join(__dirname, 'public');
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }
  app.use(express.static('public'));
  app.get('/book/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});
app.get('/collection-products/:collectionId', async (req, res) => {
  try {
    const collectionId = req.params.collectionId;
    
    // Parámetros de paginación
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    
    // Parámetros de ordenación
    const sortField = req.query.sort_field || 'title';
    const sortOrder = req.query.sort_order || 'asc';
    
    // Obtener productos de la colección
    const products = await shopify.product.list({
      collection_id: collectionId,
      limit: 250, // Máximo permitido por Shopify en una sola consulta
      fields: 'id,title,handle,variants,images,created_at,updated_at'
    });
    
    // Procesamiento de productos para clasificar los agotados al final
    const processedProducts = products.map(product => {
      // Verificar si el producto está agotado (todas las variantes sin inventario)
      const isOutOfStock = product.variants.every(
        variant => variant.inventory_quantity <= 0 && variant.inventory_policy =='deny'
      );
      
      return {
        ...product,
        isOutOfStock
      };
    });
    
    // Ordenar productos (primero por el campo seleccionado, después por disponibilidad)
    const sortedProducts = processedProducts.sort((a, b) => {
      // Primero ordenar por disponibilidad (los no agotados primero)
      if (a.isOutOfStock !== b.isOutOfStock) {
        return a.isOutOfStock ? 1 : -1;
      }
      
      // Luego ordenar por el campo seleccionado
      if (a[sortField] < b[sortField]) {
        return sortOrder === 'asc' ? -1 : 1;
      }
      if (a[sortField] > b[sortField]) {
        return sortOrder === 'asc' ? 1 : -1;
      }
      return 0;
    });
    
    // Implementar paginación
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedProducts = sortedProducts.slice(startIndex, endIndex);
    
    // Preparar respuesta
    const response = {
      products: paginatedProducts,
      pagination: {
        total: sortedProducts.length,
        page,
        limit,
        totalPages: Math.ceil(sortedProducts.length / limit)
      }
    };
    
    res.json(response);
  } catch (error) {
    console.error('Error al obtener productos de la colección:', error);
    res.status(500).json({ error: 'Error al procesar la solicitud' });
  }
});

  // Configurar ruta principal
  app.get('/', (req, res) => {
    const pdfPath = path.join(__dirname, 'public', 'productos_shopify.pdf');
    
    if (fs.existsSync(pdfPath)) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename=catálogo.pdf');
      res.sendFile(pdfPath);
    } else {
      res.status(404).send('El catálogo aún no está disponible. Por favor intente más tarde.');
    }
  });
 
  // Iniciar servidor web
  const PORT = process.env.PORT || 3090;
  app.listen(PORT, () => {
    console.log(`Servidor escuchando en http://localhost:${PORT}`);
  });

  // Ejecutar inmediatamente al iniciar
  updateProductsPDF();

  // Programar ejecución cada 6 horas
  cron.schedule('0 */6 * * *', () => {
    console.log('Ejecutando verificación programada...');
    updateProductsPDF();
  });

  console.log('Aplicación iniciada. Se verificarán cambios en productos cada 6 horas.');
}

// Iniciar la aplicación
startApp();