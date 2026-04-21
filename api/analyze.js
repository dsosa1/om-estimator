export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const GOOGLE_KEY    = process.env.GOOGLE_MAPS_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { address, name, specialty, url, current, target } = body || {};

  try {
    // ── 1. GEOCODE ────────────────────────────────────────────────────────────
    const geoRes = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_KEY}`
    );
    const geoData = await geoRes.json();
    if (!geoData.results?.length) return res.status(400).json({ error: 'Address not found' });

    const loc   = geoData.results[0].geometry.location;
    const comps = geoData.results[0].address_components;
    const zip   = comps.find(c => c.types.includes('postal_code'))?.short_name || '';
    const city  = comps.find(c => c.types.includes('locality'))?.long_name || '';
    const state = comps.find(c => c.types.includes('administrative_area_level_1'))?.short_name || '';

    // ── 2. NEARBY DENTISTS ────────────────────────────────────────────────────
    const placesRes = await fetch(
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${loc.lat},${loc.lng}&radius=8047&type=dentist&key=${GOOGLE_KEY}`
    );
    const placesData = await placesRes.json();
    const competitors = placesData.results || [];
    const compCount   = competitors.length;
    const competitionLevel = compCount >= 20 ? 'high' : compCount >= 10 ? 'medium' : 'low';

    // ── 3. CENSUS DATA ────────────────────────────────────────────────────────
    let census = { population: null, medianIncome: null, medianAge: null };
    if (zip) {
      try {
        const censusRes = await fetch(
          `https://api.census.gov/data/2022/acs/acs5?get=B01003_001E,B19013_001E,B01002_001E&for=zip%20code%20tabulation%20area:${zip}`
        );
        const censusData = await censusRes.json();
        if (censusData[1]) {
          census = {
            population:    parseInt(censusData[1][0]) || null,
            medianIncome:  parseInt(censusData[1][1]) || null,
            medianAge:     parseFloat(censusData[1][2]) || null,
          };
        }
      } catch {}
    }

    // ── 4. ADJUST CPA BASELINE ────────────────────────────────────────────────
    const incomeMultiplier = census.medianIncome
      ? census.medianIncome > 80000 ? 1.2 : census.medianIncome < 45000 ? 0.85 : 1.0
      : 1.0;
    const compMultiplier = competitionLevel === 'high' ? 1.25 : competitionLevel === 'low' ? 0.85 : 1.0;
    const baseCPA = Math.round(185 * incomeMultiplier * compMultiplier);

    // ── 5. CLAUDE ANALYSIS ────────────────────────────────────────────────────
    const gap = target - current;
    const prompt = `You are a dental performance marketing expert at OM Performance Marketing. Use this REAL market data to inform your analysis.

Practice:
- Name: ${name || 'Unknown'}
- Address: ${address}
- City: ${city}, ${state}
- ZIP: ${zip}
- Specialty: ${specialty || 'General Dentistry'}
- Website: ${url || 'not provided'}
- Current monthly new patients: ${current}
- Target monthly new patients: ${target}
- Gap: ${gap} NPs/month

REAL MARKET DATA:
- Competing dental practices within 5 miles: ${compCount}
- Competition level: ${competitionLevel}
- ZIP population: ${census.population?.toLocaleString() || 'unknown'}
- Median household income: ${census.medianIncome ? '$' + census.medianIncome.toLocaleString() : 'unknown'}
- Median age: ${census.medianAge || 'unknown'}
- Adjusted CPA baseline: $${baseCPA}

Respond ONLY with valid JSON (no markdown, no backticks):
{
  "avg_cpc_search": <realistic Google Ads CPC $ for dental in ${city} given ${competitionLevel} competition>,
  "suggested_monthly_budget": <total $ media+management to close the gap using $${baseCPA} CPA baseline>,
  "media_spend": <ad spend portion $>,
  "management_fee": <agency fee portion $>,
  "google_search_budget": <monthly $ Google Search>,
  "google_lsa_budget": <monthly $ Google LSA>,
  "social_budget": <monthly $ paid social>,
  "seo_budget": <monthly $ SEO/content>,
  "cpa_google_search": <est $ per new patient Google Search>,
  "cpa_google_lsa": <est $ per new patient Google LSA>,
  "cpa_social": <est $ per new patient paid social>,
  "blended_cpa": ${baseCPA},
  "projected_nps_from_budget": <est NPs/month>,
  "months_to_goal": <est months to reach target>,
  "market_insights": [
    "<insight using real competitor count of ${compCount} practices>",
    "<insight using real population/income for ${city}>",
    "<insight about the growth gap>",
    "<insight specific to ${specialty || 'General Dentistry'} in this market>"
  ],
  "strategy_recommendations": [
    "<top channel priority given ${competitionLevel} competition>",
    "<quick win for this market>",
    "<longer-term growth lever>",
    "<specialty or location specific rec>"
  ],
  "roi_note": "<one sentence ROI projection using median income of ${census.medianIncome ? '$' + census.medianIncome.toLocaleString() : 'unknown'}>"
}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const claudeData = await claudeRes.json();
    const raw = claudeData.content?.find(b => b.type === 'text')?.text || '';
    const analysis = JSON.parse(raw.replace(/```json|```/g, '').trim());

    return res.status(200).json({
      analysis,
      geo: { lat: loc.lat, lng: loc.lng, zip, city, state },
      census,
      competitors: competitors.slice(0, 8).map(c => ({
        name: c.name,
        rating: c.rating,
        reviews: c.user_ratings_total,
      })),
      compCount,
      competitionLevel,
      baseCPA,
    });

  } catch (err) {
    console.error('ANALYZE ERROR:', err);
    return res.status(500).json({
      error: err.message,
      step: err.step || 'unknown',
      stack: err.stack,
    });
  }
}
