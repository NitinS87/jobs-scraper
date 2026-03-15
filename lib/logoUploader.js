const axios = require('axios');
const cheerio = require('cheerio');
const supabase = require('./supabaseClient');

function slugify(name) {
  return (name || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function getExtFromContentType(contentType) {
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
  };
  return map[(contentType || '').split(';')[0].trim().toLowerCase()] || 'png';
}

function getExtFromUrl(url) {
  const match = (url || '').match(/\.(png|jpg|jpeg|gif|webp|svg|ico)(\?|$)/i);
  return match ? match[1].toLowerCase().replace('jpeg', 'jpg') : null;
}

async function downloadAndUploadLogo(logoUrl, companyName) {
  if (!logoUrl) return null;

  try {
    const response = await axios.get(logoUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    // Skip empty responses
    if (!response.data || response.data.length === 0) {
      console.warn(`Logo empty for ${companyName}, skipping`);
      return null;
    }

    const ext = getExtFromUrl(logoUrl) || getExtFromContentType(response.headers['content-type']);
    const slug = slugify(companyName);
    const path = `company-logos/${slug}.${ext}`;
    const contentType = response.headers['content-type'] || `image/${ext}`;

    const { error } = await supabase.storage
      .from('applymint')
      .upload(path, response.data, {
        contentType,
        upsert: true,
      });

    if (error) {
      console.warn(`Logo upload failed for ${companyName}:`, error.message);
      return null;
    }

    const { data } = supabase.storage.from('applymint').getPublicUrl(path);
    return data.publicUrl;
  } catch (err) {
    console.warn(`Logo download failed for ${companyName}:`, err.message);
    return null;
  }
}

async function tryExtractLogo(companyWebsite) {
  if (!companyWebsite) return null;

  try {
    const url = companyWebsite.startsWith('http') ? companyWebsite : `https://${companyWebsite}`;
    const response = await axios.get(url, {
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      maxRedirects: 3,
    });

    const $ = cheerio.load(response.data);
    const base = new URL(url);

    // Try in order: og:image, apple-touch-icon, icon png
    const candidates = [
      $('meta[property="og:image"]').attr('content'),
      $('link[rel="apple-touch-icon"]').attr('href'),
      $('link[rel="icon"][type="image/png"]').attr('href'),
    ];

    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const resolved = new URL(candidate, base).href;
        return resolved;
      } catch {
        continue;
      }
    }
  } catch {
    // Silently fail — logo extraction is best-effort
  }

  return null;
}

async function getGoogleFavicon(domain, companyName) {
  try {
    const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
    return await downloadAndUploadLogo(url, companyName);
  } catch {
    return null;
  }
}

module.exports = { downloadAndUploadLogo, tryExtractLogo, getGoogleFavicon };
