import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';
import archiver from 'archiver';
import https from 'https';
import http from 'http';
import multer from 'multer';
import sharp from 'sharp';

const app = express();
app.use(cors());
app.use(express.json());

// Multer setup for file uploads (store in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // max 50MB per file upload
});

const activeSessions = new Map();

const SESSION_TIMEOUT = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of activeSessions) {
    if (now - session.createdAt > SESSION_TIMEOUT) {
      activeSessions.delete(sessionId);
      console.log(`Session ${sessionId} rensad`);
    }
  }
}, 5 * 60 * 1000);

async function downloadImageToBuffer(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    
    const request = (targetUrl) => {
      protocol.get(targetUrl, (response) => {
        if (response.statusCode === 200) {
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => resolve(Buffer.concat(chunks)));
        } else if (response.statusCode === 301 || response.statusCode === 302) {
          request(response.headers.location);
        } else {
          reject(new Error(`Failed to download: ${response.statusCode}`));
        }
      }).on('error', reject);
    };
    
    request(url);
  });
}

app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;
  
  if (!url || !url.includes('qopla.com')) {
    return res.status(400).json({ error: 'Ogiltig Qopla URL' });
  }

  const sessionId = Date.now().toString();
  activeSessions.set(sessionId, { 
    status: 'starting', 
    progress: 0, 
    total: 0, 
    images: [],
    imageBuffers: new Map(),
    createdAt: Date.now()
  });

  res.json({ sessionId, message: 'Skrapning startad' });

  scrapeQoplaImages(url, sessionId).catch(err => {
    console.error('Scraping error:', err);
    const session = activeSessions.get(sessionId);
    if (session) {
      session.status = 'error';
      session.error = err.message;
    }
  });
});

app.post('/api/scrape-turbo', async (req, res) => {
  const { url, imageSize = 'medium' } = req.body;
  
  if (!url || !url.includes('qopla.com')) {
    return res.status(400).json({ error: 'Ogiltig Qopla URL' });
  }

  const validSizes = ['small', 'medium', 'large', 'original'];
  if (!validSizes.includes(imageSize)) {
    return res.status(400).json({ error: 'Ogiltig bildstorlek' });
  }

  const sessionId = Date.now().toString();
  activeSessions.set(sessionId, { 
    status: 'starting', 
    progress: 0, 
    total: 0, 
    images: [],
    imageBuffers: new Map(),
    createdAt: Date.now()
  });

  res.json({ sessionId, message: 'Turbo-hämtning startad' });

  scrapeQoplaImagesTurbo(url, sessionId, imageSize).catch(err => {
    console.error('Turbo scraping error:', err);
    const session = activeSessions.get(sessionId);
    if (session) {
      session.status = 'error';
      session.error = err.message;
    }
  });
});

app.get('/api/progress/:sessionId', (req, res) => {
  const session = activeSessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const { imageBuffers, ...safeSession } = session;
  res.json(safeSession);
});

app.get('/api/image/:sessionId/:filename', (req, res) => {
  const session = activeSessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const buffer = session.imageBuffers.get(req.params.filename);
  if (!buffer) {
    return res.status(404).json({ error: 'Bilden hittades inte' });
  }
  
  const ext = req.params.filename.split('.').pop().toLowerCase();
  const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';
  
  res.set('Content-Type', contentType);
  res.send(buffer);
});

app.get('/api/download/:sessionId', (req, res) => {
  const session = activeSessions.get(req.params.sessionId);
  if (!session || session.imageBuffers.size === 0) {
    return res.status(404).json({ error: 'Filen hittades inte' });
  }

  const archive = archiver('zip', { zlib: { level: 9 } });
  
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${session.restaurantName}_bilder.zip"`);
  
  archive.pipe(res);
  
  for (const [filename, buffer] of session.imageBuffers) {
    archive.append(buffer, { name: filename });
  }
  
  archive.finalize();
  
  archive.on('end', () => {
    activeSessions.delete(req.params.sessionId);
    console.log(`Session ${req.params.sessionId} rensad efter nedladdning`);
  });
});

async function scrapeQoplaImages(url, sessionId) {
  const session = activeSessions.get(sessionId);
  session.status = 'launching';
  
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    session.status = 'navigating';
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);
    
    const urlMatch = url.match(/restaurant\/([^\/]+)\//);
    const restaurantName = urlMatch ? urlMatch[1].replace(/-/g, '_') : 'restaurant';
    session.restaurantName = restaurantName;
    
    session.status = 'finding_products';
    
    let productCards = await page.$$('article, [data-testid*="product"], .product-card, a[href*="/product"]');
    
    if (productCards.length === 0) {
      productCards = await page.$$('div[role="button"], button');
      productCards = productCards.slice(0, 100);
    }
    
    const validCards = [];
    for (const card of productCards) {
      try {
        const hasImage = await card.$('img');
        const text = await card.textContent();
        if (hasImage && text && text.length > 5 && text.length < 500) {
          validCards.push(card);
        }
      } catch (e) {}
    }
    
    productCards = validCards.length > 0 ? validCards : productCards.slice(0, 50);
    
    session.total = productCards.length;
    session.status = 'scraping';
    
    const downloadedImages = [];
    const seenUrls = new Set();
    
    for (let i = 0; i < productCards.length; i++) {
      session.progress = i + 1;
      
      try {
        await productCards[i].scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        
        try {
          await productCards[i].click({ timeout: 3000 });
        } catch (e) {
          await productCards[i].evaluate(el => el.click());
        }
        
        await page.waitForTimeout(1000);
        await page.waitForSelector('[role="dialog"], .modal, [class*="Modal"]', { timeout: 3000 }).catch(() => {});
        
        let productName = '';
        
        try {
          const headingSelectors = [
            '[role="dialog"] h1',
            '[role="dialog"] h2',
            '[role="dialog"] h3',
            '.modal h1',
            '.modal h2',
            '[class*="Modal"] h1',
            '[class*="Modal"] h2'
          ];
          
          for (const selector of headingSelectors) {
            const titleEl = await page.$(selector);
            if (titleEl) {
              const text = await titleEl.textContent();
              if (text && text.trim().length > 2 && text.trim().length < 100) {
                productName = text.trim();
                break;
              }
            }
          }
          
          if (!productName) {
            const modalContent = await page.$('[role="dialog"], .modal, [class*="Modal"]');
            if (modalContent) {
              const firstText = await modalContent.evaluate(el => {
                const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
                let node;
                while (node = walker.nextNode()) {
                  const text = node.textContent.trim();
                  if (text.length > 3 && text.length < 80 && !text.includes('kr') && !text.includes('Välj')) {
                    return text;
                  }
                }
                return '';
              });
              if (firstText) productName = firstText;
            }
          }
          
          if (!productName) {
            const modal = await page.$('[role="dialog"], .modal');
            if (modal) {
              const ariaLabel = await modal.getAttribute('aria-label');
              if (ariaLabel && ariaLabel.length > 2) productName = ariaLabel;
            }
          }
        } catch (e) {}

        const modalImages = await page.$$('[role="dialog"] img, .modal img, [class*="Modal"] img, [class*="modal"] img');
        
        for (const img of modalImages) {
          try {
            const isVisible = await img.isVisible();
            if (!isVisible) continue;
            
            let imageUrl = await img.getAttribute('src');
            const srcset = await img.getAttribute('srcset');
            
            if (srcset) {
              const srcsetUrls = srcset.split(',').map(s => s.trim().split(' ')[0]);
              imageUrl = srcsetUrls[srcsetUrls.length - 1] || imageUrl;
            }
            
            if (!imageUrl || imageUrl.startsWith('data:')) continue;
            if (!imageUrl.startsWith('http')) {
              imageUrl = new URL(imageUrl, url).href;
            }
            
            if (seenUrls.has(imageUrl)) continue;
            seenUrls.add(imageUrl);
            
            const altText = await img.getAttribute('alt') || '';
            let baseName = productName || altText || `product_${i + 1}`;
            
            const cleanName = baseName
              .replace(/[<>:"/\\|?*]/g, '')
              .replace(/\s+/g, '_')
              .replace(/_{2,}/g, '_')
              .substring(0, 80)
              .trim();
            
            const ext = imageUrl.includes('.png') ? '.png' : '.jpg';
            const filename = cleanName ? `${cleanName}${ext}` : `product_${i + 1}${ext}`;
            
            try {
              const buffer = await downloadImageToBuffer(imageUrl);
              session.imageBuffers.set(filename, buffer);
              
              downloadedImages.push({ 
                filename, 
                productName: productName || altText,
                imagePath: `/api/image/${sessionId}/${encodeURIComponent(filename)}`
              });
              session.images = downloadedImages;
              console.log(`Downloaded: ${filename}`);
            } catch (err) {
              console.log(`Failed to download: ${err.message}`);
            }
            
            break;
          } catch (e) {}
        }
        
        const closeBtn = await page.$('button[aria-label*="close"], button[aria-label*="stäng"], [class*="close"]');
        if (closeBtn) {
          await closeBtn.click().catch(() => {});
        }
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        
      } catch (err) {
        console.log(`Error on product ${i + 1}: ${err.message}`);
        await page.keyboard.press('Escape').catch(() => {});
      }
    }
    
    session.status = 'completed';
    session.images = downloadedImages;
    
  } catch (error) {
    session.status = 'error';
    session.error = error.message;
  } finally {
    await browser.close();
  }
}

// Transform S3 URL to desired size
function transformS3Url(imageUrl, targetSize) {
  // Match S3 URL pattern: https://s3-eu-west-1.amazonaws.com/qopla/{id}/Gallery/{size}/{filename}
  const s3Pattern = /^(https:\/\/s3[^\/]*\.amazonaws\.com\/qopla\/[^\/]+\/Gallery\/)(small|medium|large|original)(\/.+)$/;
  const match = imageUrl.match(s3Pattern);
  
  if (match) {
    return `${match[1]}${targetSize}${match[3]}`;
  }
  
  // Also try without Gallery path - some images might have different structure
  const s3PatternAlt = /^(https:\/\/s3[^\/]*\.amazonaws\.com\/qopla\/[^\/]+\/)(small|medium|large|original)(\/.+)$/;
  const matchAlt = imageUrl.match(s3PatternAlt);
  
  if (matchAlt) {
    return `${matchAlt[1]}${targetSize}${matchAlt[3]}`;
  }
  
  return imageUrl;
}

// Extract product name from various sources
function extractProductName(card, index) {
  return card.evaluate((el, idx) => {
    // Try to find product name in common patterns
    const nameSelectors = [
      'h1', 'h2', 'h3', 'h4',
      '[class*="name"]', '[class*="title"]', '[class*="heading"]',
      'span:first-child', 'p:first-child'
    ];
    
    for (const selector of nameSelectors) {
      const nameEl = el.querySelector(selector);
      if (nameEl) {
        const text = nameEl.textContent.trim();
        // Filter out prices and invalid names
        if (text.length > 2 && text.length < 100 && !text.match(/^\d+\s*kr$/)) {
          return text;
        }
      }
    }
    
    // Try text content of the card itself
    const text = el.textContent.trim();
    const firstLine = text.split('\n')[0].trim();
    if (firstLine.length > 2 && firstLine.length < 80 && !firstLine.match(/^\d+\s*kr$/)) {
      return firstLine;
    }
    
    return `product_${idx + 1}`;
  }, index);
}

async function scrapeQoplaImagesTurbo(url, sessionId, imageSize) {
  const session = activeSessions.get(sessionId);
  session.status = 'launching';
  
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    session.status = 'navigating';
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);
    
    const urlMatch = url.match(/restaurant\/([^\/]+)\//);
    const restaurantName = urlMatch ? urlMatch[1].replace(/-/g, '_') : 'restaurant';
    session.restaurantName = restaurantName;
    
    session.status = 'extracting_urls';
    
    // Find all product cards with images
    const productCards = await page.$$('article, [data-testid*="product"], .product-card, div[role="button"], button');
    
    const imageData = [];
    const seenUrls = new Set();
    
    // Extract all image URLs from the page without clicking
    for (let i = 0; i < productCards.length; i++) {
      try {
        const card = productCards[i];
        const imgs = await card.$$('img');
        
        for (const img of imgs) {
          try {
            let imageUrl = await img.getAttribute('src');
            const srcset = await img.getAttribute('srcset');
            
            // Prefer srcset for higher quality
            if (srcset) {
              const srcsetUrls = srcset.split(',').map(s => s.trim().split(' ')[0]);
              // Get the largest one
              imageUrl = srcsetUrls[srcsetUrls.length - 1] || imageUrl;
            }
            
            if (!imageUrl || imageUrl.startsWith('data:')) continue;
            if (!imageUrl.startsWith('http')) {
              imageUrl = new URL(imageUrl, url).href;
            }
            
            // Only process S3 bucket URLs
            if (!imageUrl.includes('amazonaws.com/qopla')) continue;
            
            // Transform to desired size
            const transformedUrl = transformS3Url(imageUrl, imageSize);
            
            if (seenUrls.has(transformedUrl)) continue;
            seenUrls.add(transformedUrl);
            
            // Get product name
            const altText = await img.getAttribute('alt') || '';
            const productName = await extractProductName(card, i) || altText || `product_${i + 1}`;
            
            imageData.push({
              url: transformedUrl,
              productName,
              originalUrl: imageUrl
            });
            
          } catch (e) {}
        }
      } catch (e) {}
    }
    
    session.total = imageData.length;
    session.status = 'downloading_turbo';
    
    const downloadedImages = [];
    
    // Download all images in parallel batches
    const batchSize = 5;
    for (let i = 0; i < imageData.length; i += batchSize) {
      const batch = imageData.slice(i, i + batchSize);
      
      const results = await Promise.allSettled(
        batch.map(async (data, batchIdx) => {
          const idx = i + batchIdx;
          try {
            const buffer = await downloadImageToBuffer(data.url);
            
            const cleanName = data.productName
              .replace(/[<>:"/\\|?*]/g, '')
              .replace(/\s+/g, '_')
              .replace(/_{2,}/g, '_')
              .substring(0, 80)
              .trim();
            
            const ext = data.url.includes('.png') ? '.png' : '.jpg';
            const filename = cleanName ? `${cleanName}${ext}` : `product_${idx + 1}${ext}`;
            
            session.imageBuffers.set(filename, buffer);
            
            return { 
              filename, 
              productName: data.productName,
              imagePath: `/api/image/${sessionId}/${encodeURIComponent(filename)}`
            };
          } catch (err) {
            console.log(`Failed to download ${data.url}: ${err.message}`);
            return null;
          }
        })
      );
      
      // Add successful downloads
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          downloadedImages.push(result.value);
          console.log(`⚡ Turbo downloaded: ${result.value.filename}`);
        }
      }
      
      session.progress = Math.min(i + batchSize, imageData.length);
      session.images = downloadedImages;
    }
    
    session.status = 'completed';
    session.images = downloadedImages;
    
  } catch (error) {
    session.status = 'error';
    session.error = error.message;
  } finally {
    await browser.close();
  }
}

// ==========================================
// IMAGE COMPRESSION ENDPOINTS
// ==========================================

const compressSessions = new Map();

// Compress a single image buffer to target max size (in bytes)
async function compressImageToTarget(buffer, targetBytes, originalName) {
  const metadata = await sharp(buffer).metadata();
  const format = metadata.format; // jpeg, png, webp, etc.

  // If already under target, return as-is
  if (buffer.length <= targetBytes) {
    return { buffer, format: format || 'jpeg', alreadySmall: true };
  }

  // Strategy: iteratively reduce quality for JPEG/WebP, or convert PNG to JPEG
  let outputFormat = (format === 'png') ? 'png' : 'jpeg';
  let quality = 95;
  let result = buffer;
  let width = metadata.width;

  // First try reducing quality
  while (quality >= 10) {
    let pipeline = sharp(buffer);

    if (outputFormat === 'jpeg') {
      pipeline = pipeline.jpeg({ quality, mozjpeg: true });
    } else if (outputFormat === 'png') {
      pipeline = pipeline.png({ quality: Math.max(quality, 20), compressionLevel: 9 });
    }

    result = await pipeline.toBuffer();

    if (result.length <= targetBytes) {
      return { buffer: result, format: outputFormat, quality };
    }

    quality -= 5;
  }

  // If PNG is still too large, convert to JPEG
  if (outputFormat === 'png') {
    outputFormat = 'jpeg';
    quality = 90;
    while (quality >= 10) {
      result = await sharp(buffer).jpeg({ quality, mozjpeg: true }).toBuffer();
      if (result.length <= targetBytes) {
        return { buffer: result, format: 'jpeg', quality, converted: true };
      }
      quality -= 5;
    }
  }

  // Last resort: reduce dimensions step by step
  let scale = 0.9;
  while (scale >= 0.1) {
    const newWidth = Math.round(width * scale);
    result = await sharp(buffer)
      .resize(newWidth)
      .jpeg({ quality: 60, mozjpeg: true })
      .toBuffer();

    if (result.length <= targetBytes) {
      return { buffer: result, format: 'jpeg', quality: 60, resized: true, scale };
    }
    scale -= 0.1;
  }

  // Return the smallest we could get
  return { buffer: result, format: 'jpeg', quality: 60, resized: true };
}

// POST /api/compress - compress a single image
app.post('/api/compress', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Ingen bild uppladdad' });
    }

    const targetMB = parseFloat(req.body.targetMB) || 5;
    const targetBytes = targetMB * 1024 * 1024;

    const originalSize = req.file.size;
    const originalName = req.file.originalname;

    const { buffer, format, alreadySmall } = await compressImageToTarget(
      req.file.buffer,
      targetBytes,
      originalName
    );

    const sessionId = `compress_${Date.now()}`;
    // Keep original filename as-is
    const filename = originalName;

    compressSessions.set(sessionId, {
      buffer,
      filename,
      format,
      originalSize,
      compressedSize: buffer.length,
      createdAt: Date.now()
    });

    // Clean up old compress sessions after 30 min
    setTimeout(() => compressSessions.delete(sessionId), 30 * 60 * 1000);

    res.json({
      sessionId,
      filename,
      originalSize,
      compressedSize: buffer.length,
      alreadySmall: !!alreadySmall
    });
  } catch (err) {
    console.error('Compress error:', err);
    res.status(500).json({ error: 'Kunde inte komprimera bilden: ' + err.message });
  }
});

// GET /api/compress/download/:sessionId - download compressed single image
app.get('/api/compress/download/:sessionId', (req, res) => {
  const session = compressSessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session hittades inte' });
  }

  const contentType = session.format === 'png' ? 'image/png' : 'image/jpeg';
  res.set('Content-Type', contentType);
  res.set('Content-Disposition', `attachment; filename="${session.filename}"`);
  res.send(session.buffer);
});

// POST /api/compress-batch - compress multiple images (from folder upload)
app.post('/api/compress-batch', upload.array('images', 200), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Inga bilder uppladdade' });
    }

    const targetMB = parseFloat(req.body.targetMB) || 5;
    const targetBytes = targetMB * 1024 * 1024;

    const sessionId = `batch_${Date.now()}`;
    const batchSession = {
      status: 'processing',
      total: req.files.length,
      processed: 0,
      results: [],
      imageBuffers: new Map(),
      createdAt: Date.now()
    };
    compressSessions.set(sessionId, batchSession);

    // Clean up after 30 min
    setTimeout(() => compressSessions.delete(sessionId), 30 * 60 * 1000);

    // Return session ID immediately
    res.json({ sessionId, total: req.files.length });

    // Parse relative paths sent from frontend (for folder structure in ZIP)
    let relativePaths = [];
    try {
      if (req.body.relativePaths) {
        relativePaths = JSON.parse(req.body.relativePaths);
      }
    } catch (e) {}

    // Process in background
    (async () => {
      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];
        try {
          const { buffer, format } = await compressImageToTarget(
            file.buffer,
            targetBytes,
            file.originalname
          );

          // Use relative path if available, otherwise just the original filename
          const relativePath = relativePaths[i] || file.originalname;
          const filename = relativePath;

          batchSession.imageBuffers.set(filename, buffer);
          batchSession.results.push({
            filename,
            originalName: file.originalname,
            originalSize: file.size,
            compressedSize: buffer.length,
            imagePath: `/api/compress/preview/${sessionId}/${encodeURIComponent(filename)}`
          });
        } catch (err) {
          batchSession.results.push({
            filename: file.originalname,
            originalName: file.originalname,
            originalSize: file.size,
            error: err.message
          });
        }
        batchSession.processed = i + 1;
      }
      batchSession.status = 'completed';
    })();
  } catch (err) {
    console.error('Batch compress error:', err);
    res.status(500).json({ error: 'Kunde inte komprimera bilderna: ' + err.message });
  }
});

// GET /api/compress/batch-progress/:sessionId - poll batch progress
app.get('/api/compress/batch-progress/:sessionId', (req, res) => {
  const session = compressSessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session hittades inte' });
  }

  const { imageBuffers, ...safeSession } = session;
  res.json(safeSession);
});

// GET /api/compress/preview/:sessionId/:filename - preview a compressed image
app.get('/api/compress/preview/:sessionId/:filename', (req, res) => {
  const session = compressSessions.get(req.params.sessionId);
  if (!session || !session.imageBuffers) {
    return res.status(404).json({ error: 'Session hittades inte' });
  }

  const buffer = session.imageBuffers.get(decodeURIComponent(req.params.filename));
  if (!buffer) {
    return res.status(404).json({ error: 'Bilden hittades inte' });
  }

  const ext = req.params.filename.split('.').pop().toLowerCase();
  const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';
  res.set('Content-Type', contentType);
  res.send(buffer);
});

// GET /api/compress/batch-download/:sessionId - download all as ZIP
app.get('/api/compress/batch-download/:sessionId', (req, res) => {
  const session = compressSessions.get(req.params.sessionId);
  if (!session || !session.imageBuffers || session.imageBuffers.size === 0) {
    return res.status(404).json({ error: 'Inga bilder att ladda ner' });
  }

  const archive = archiver('zip', { zlib: { level: 9 } });

  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', 'attachment; filename="komprimerade_bilder.zip"');

  archive.pipe(res);

  for (const [filename, buffer] of session.imageBuffers) {
    archive.append(buffer, { name: filename });
  }

  archive.finalize();

  archive.on('end', () => {
    compressSessions.delete(req.params.sessionId);
    console.log(`Compress session ${req.params.sessionId} rensad efter nedladdning`);
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server körs på http://localhost:${PORT}`);
});
