import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';
import archiver from 'archiver';
import https from 'https';
import http from 'http';

const app = express();
app.use(cors());
app.use(express.json());

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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server körs på http://localhost:${PORT}`);
});
