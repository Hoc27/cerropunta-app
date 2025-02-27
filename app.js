const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const dotenv = require('dotenv')
const app = express();
const Shopify = require('shopify-api-node');
dotenv.config();
// Configuración de la API de Shopify
const shopify = new Shopify({
  shopName: process.env.SHOPIFY_SHOP_NAME,
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN
});

// Cargar variables de entorno

const pdfGenerator = require('./pdfWorker');
// Configurar CORS
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
// Ruta de health check para Railway
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

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

// Endpoint para ver la página de lectura
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

app.post('/generate-pdf', async (req, res) => {
  const status = pdfGenerator.getGenerationStatus();
  
  if (status.isGenerating) {
    return res.status(409).json({
      status: 'in_progress',
      message: 'Ya hay una generación en curso',
      progress: status.progress,
      currentStatus: status.status
    });
  }
  
  // Responder inmediatamente que la tarea se ha iniciado
  res.status(202).json({
    status: 'initiated',
    message: 'Generación de PDF iniciada'
  });
  
  // Iniciar la generación en segundo plano
  pdfGenerator.updateProductsPDF().catch(err => {
    console.error('Error en generación de PDF:', err);
  });
});

// Endpoint para verificar el estado de la generación
app.get('/generation-status', (req, res) => {
  res.json(pdfGenerator.getGenerationStatus());
});
app.use(express.static('public'));
// Función para iniciar la aplicación
function startServer() {
  // Asegurar que existe el directorio public
  const publicDir = path.join(__dirname, 'public');
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }
  
  // Iniciar servidor
  const PORT = process.env.PORT || 3090;
  app.listen(PORT, () => {
    console.log(`Servidor iniciado en puerto ${PORT}`);
    
    // Programar la generación del PDF
    cron.schedule('0 */6 * * *', () => {
      console.log('Ejecutando generación programada...');
      pdfGenerator.updateProductsPDF().catch(err => {
        console.error('Error en generación programada:', err);
      });
    });
    
    // Si no existe el PDF, iniciarlo en segundo plano después de iniciar el servidor
    const pdfPath = path.join(__dirname, 'public', 'productos_shopify.pdf');
    if (!fs.existsSync(pdfPath)) {
      console.log('No se encontró un catálogo existente. Iniciando generación inicial...');
      // Esperar 5 segundos antes de iniciar la generación para dar tiempo al servidor
      setTimeout(() => {
        pdfGenerator.updateProductsPDF().catch(err => {
          console.error('Error en generación inicial:', err);
        });
      }, 5000);
    }
  });
}

// Iniciar el servidor
startServer();