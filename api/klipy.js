export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const appKey = process.env.KLIPY_API_KEY || 'qUbWlJZVfjk1dLpW89qJ48lZW8KFxMAl6sBCCwUfbtfwlUCuw585ISUTqJmCvULt';
  const action = req.query.action || (req.query.q ? 'search' : 'trending');
  const query = req.query.q ? encodeURIComponent(String(req.query.q).trim()) : '';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 50);
  const page = parseInt(req.query.page, 10) || 1;
  const adPosition = req.query['ad-position'] !== undefined ? req.query['ad-position'] : 1;

  let klipyEndpoint = '';
  const queryParams = new URLSearchParams({
    limit: String(limit),
    page: String(page),
    'ad-position': String(adPosition),
    'ad-min-width': '200',
    'ad-max-width': '640',
    'ad-min-height': '150',
    'ad-max-height': '350'
  });

  if (action === 'search' && query) {
    queryParams.set('q', req.query.q.trim());
    klipyEndpoint = `https://api.klipy.com/api/v1/${appKey}/gifs/search?${queryParams.toString()}`;
  } else {
    klipyEndpoint = `https://api.klipy.com/api/v1/${appKey}/gifs/trending?${queryParams.toString()}`;
  }

  try {
    const clientUa = req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MR-CAPSULES/2.0';
    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';

    const headers = {
      'User-Agent': clientUa,
      'Accept': 'application/json'
    };
    if (clientIp) {
      headers['X-Forwarded-For'] = clientIp.split(',')[0].trim();
    }

    const response = await fetch(klipyEndpoint, { headers });
    if (!response.ok) {
      const errBody = await response.text();
      return res.status(response.status).json({
        success: false,
        error: `Klipy API responded with status ${response.status}`,
        details: errBody
      });
    }

    const data = await response.json();
    const items = data.data?.data || [];

    // Format items for easy frontend consumption
    const formatted = items.map(item => {
      const isAd = item.type === 'ad';
      const file = item.file || {};
      const gifUrl = file.hd?.gif?.url || file.md?.gif?.url || file.sm?.gif?.url || item.url || '';
      const webpUrl = file.hd?.webp?.url || file.md?.webp?.url || file.sm?.webp?.url || '';
      const thumbUrl = file.sm?.webp?.url || file.sm?.gif?.url || file.sm?.jpg?.url || gifUrl;

      return {
        id: item.id,
        type: item.type || 'gif',
        is_ad: isAd,
        title: item.title || (isAd ? 'Sponsored' : 'Klipy GIF'),
        slug: item.slug || '',
        gif_url: gifUrl,
        webp_url: webpUrl,
        thumb_url: thumbUrl,
        click_url: item.click_url || item.target_url || item.url || null,
        dimensions: {
          width: file.hd?.gif?.width || file.md?.gif?.width || 480,
          height: file.hd?.gif?.height || file.md?.gif?.height || 270
        },
        blur_preview: item.blur_preview || null,
        raw: item
      };
    });

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.status(200).json({
      success: true,
      action,
      query: req.query.q || null,
      count: formatted.length,
      ads_count: formatted.filter(i => i.is_ad).length,
      items: formatted
    });
  } catch (err) {
    console.error('[Klipy Proxy Error]:', err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}
