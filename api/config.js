// Netlify Function to serve environment variables securely
exports.handler = async (event, context) => {
    // CORS headers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600' // Cache for 1 hour
    };

    // Handle OPTIONS preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    // Only allow GET requests
    if (event.httpMethod !== 'GET') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        // Return environment variables
        const config = {
            supabaseUrl: process.env.S_URL,
            supabaseKey: process.env.ANON_KEY,
            googleClientId: process.env.GCID,
            captchaKey: process.env.CAPTCHA_KEY
        };

        // Validate all required variables are present
        const missing = Object.entries(config)
            .filter(([key, value]) => !value)
            .map(([key]) => key);

        if (missing.length > 0) {
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({
                    error: 'Configuration incomplete',
                    missing: missing
                })
            };
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(config)
        };
    } catch (error) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: 'Failed to load configuration',
                message: error.message
            })
        };
    }
};
