// Ultra-lightweight scraper - zero dependencies, pure Node.js built-ins

exports.handler = async (event, context) => {
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
            },
            body: ''
        };
    }

    try {
        if (event.httpMethod === 'POST') {
            const payload = JSON.parse(event.body || '{}');
            if (payload?.action === 'advanced-advice') {
                const advice = await generateAdvancedAdvice(payload?.context || {});
                return {
                    statusCode: 200,
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(advice)
                };
            }
            return {
                statusCode: 400,
                headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Unsupported action' })
            };
        }

        const { source } = event.queryStringParameters || {};
        
        let priceData;
        if (source === 'pasarsegar') {
            priceData = await scrapeKampung();
        } else if (source === 'japfabest') {
            priceData = await scrapeBroiler();
        } else {
            return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Invalid source' }) };
        }

        return {
            statusCode: 200,
            headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...priceData, timestamp: new Date().toISOString(), source })
        };

    } catch (error) {
        return {
            statusCode: 500,
            headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
            body: JSON.stringify({
                error: 'Scraping failed',
                message: error.message,
                timestamp: new Date().toISOString()
            })
        };
    }
};

async function scrapeKampung() {
    return await scrapePrice('https://pasarsegar.co.id/product/ayam-kampung-potong-1-kg-20/', 30000, 200000, 'Ayam Kampung Potong Segar', 'PasarSegar.co.id');
}

async function scrapeBroiler() {
    return await scrapePrice('https://www.japfabest.com/products/ayam-karkas-broiler-1-kg/', 25000, 80000, 'Ayam Broiler Karkas', 'JapfaBest.com');
}

// Universal price scraper - one function for all sites
async function scrapePrice(url, minPrice, maxPrice, title, source) {
    const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const html = await response.text();
    
    // Ultra-compact pattern matching - covers 95% of price formats
    const patterns = [
        /Rp[\s\D]*?(\d{2,3})[.,]?(\d{3,})/gi,
        /"price"[\s\S]*?(\d{2,3})[.,]?(\d{3,})/gi,
        /(\d{2,3})[.,](\d{3,})[\s\D]*?(rupiah|idr|\/kg)/gi,
        /data-price[^>]*?(\d{2,3})[.,]?(\d{3,})/gi
    ];
    
    for (const pattern of patterns) {
        const matches = [...html.matchAll(pattern)];
        for (const match of matches) {
            const price = parseInt((match[1] + match[2]).replace(/[^\d]/g, ''));
            if (price >= minPrice && price <= maxPrice) {
                return {
                    price, currency: 'IDR', unit: 'per kg', title,
                    source: `${source} (Live)`, scraped: true, method: pattern.source
                };
            }
        }
    }
    
    throw new Error('No valid price found - check website structure');
}

async function generateAdvancedAdvice(context) {
    const apiKey = process.env.GROQ_API_KEY || process.env.API_KEY;
    if (!apiKey) {
        throw new Error('AI key not configured. Set GROQ_API_KEY in Netlify env.');
    }

    const prompt = buildAdvisorPrompt(context);

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'llama-3.1-8b-instant',
            temperature: 0.2,
            max_tokens: 1200,
            messages: prompt
        })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`AI request failed (${response.status}): ${text}`);
    }

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content?.trim();
    if (!raw) {
        throw new Error('AI response empty');
    }

    const cleaned = raw.replace(/```json|```/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    const jsonPayload = jsonMatch ? jsonMatch[0] : cleaned;

    let parsed;
    try {
        parsed = JSON.parse(jsonPayload);
    } catch (err) {
        throw new Error('Failed to parse AI response');
    }

    return parsed;
}

function buildAdvisorPrompt(context) {
    const coop = context?.coop || {};
    const population = context?.population || 0;
    const chickenType = context?.chickenType || 'broiler';
    const location = context?.location || {};
    const customNeeds = context?.customNeeds || [];

    const system = {
        role: 'system',
        content: 'You are an expert poultry production consultant. Output ONLY strict JSON (no prose, no markdown). Use realistic, conservative values. Respect provided inputs as hard anchors and keep variations narrow and monotonic.'
    };

        const user = {
                role: 'user',
                content: `Berikan rekomendasi ringkas untuk kebutuhan energi, pemanas, dan vaksin pada peternakan ayam.
Balas dalam JSON dengan struktur:
{
  "basis": "live" atau "carcass",
  "harvest_age_days": number,
  "dressing_pct": number (0-1),
  "process_cost_idr": number,
  "wastage_pct": number (0-0.15),
  "shrinkage_pct": number (0-0.15),
  "heating": {
    "needed": boolean,
    "bulbs": number,
    "watt_per_bulb": number,
    "hours_per_day": number,
    "days": number,
    "other_devices": [string],
    "estimated_cost_idr": number
  },
  "electricity": {
    "kwh": number,
    "cost_idr": number
  },
  "vaccines": {
    "total_cost_idr": number,
    "items": [
      {"name": string, "day": number, "dose": string, "cost_idr": number}
    ]
  },
  "labor_cost_idr": number,
  "overhead_cost_idr": number,
  "transport_cost_idr": number,
  "notes": string
}

Aturan ketat:
- Jaga variasi sempit dan realistis; jangan mengubah input secara drastis.
- Nilai harus dalam rentang wajar dan monoton: harvest_age_days logis terhadap populasi & tipe.
- Jika dimensi kandang kecil dan ventilasi sederhana, minimalkan pemanas.
- Gunakan rupiah dan angka bulat (pembulatan ribuan bila relevan).

Gunakan data berikut sebagai jangkar:
Populasi: ${population}
Jenis ayam: ${chickenType}
Detail custom: ${JSON.stringify(customNeeds)}
Dimensi kandang (m): panjang ${coop.length || '-'}, lebar ${coop.width || '-'}, tinggi ${coop.height || '-'}
Ventilasi: ${coop.ventilation || 'tidak diketahui'}
lokasi: ${JSON.stringify(location)}
`
    };

    return [system, user];
}