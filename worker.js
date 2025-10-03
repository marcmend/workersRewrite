export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const target = url.searchParams.get("target");

    if (!target) {
      return new Response("Missing ?target=…", { status: 400 });
    }

    // Petit endpoint optionnel pour lire les logs: /_logs?token=...
    if (url.pathname === "/_logs") {
      const token = url.searchParams.get("token");
      if (!token || token !== env.LOG_READ_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
      const list = await env.LOGS.list({ prefix: "log-" });
      const items = [];
      for (const key of list.keys) {
        const v = await env.LOGS.get(key.name);
        if (v) items.push(JSON.parse(v));
      }
      return new Response(JSON.stringify(items, null, 2), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    // Log infos client (IP, UA, géo Cloudflare, etc.)
    const cf = request.cf ?? {};
    const entry = {
      ts: new Date().toISOString(),
      target,
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      ip: request.headers.get("cf-connecting-ip") || null,
      userAgent: request.headers.get("user-agent") || null,
      referer: request.headers.get("referer") || null,
      acceptLanguage: request.headers.get("accept-language") || null,
      geo: {
        country: cf.country || null,
        city: cf.city || null,
        region: cf.region || null,
        latitude: cf.latitude || null,
        longitude: cf.longitude || null,
        timezone: cf.timezone || null,
        continent: cf.continent || null,
        asn: cf.asn || null,
        asOrganization: cf.asOrganization || null,
      },
    };

    // Write log (clé unique simple)
    const key = `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    ctx.waitUntil(env.LOGS.put(key, JSON.stringify(entry)));

    // Détection "bot d’unfurl" : on sert une page avec OG/Twitter/title copiés
    const ua = (entry.userAgent || "").toLowerCase();
    const isPreviewBot = looksLikeUnfurlBot(ua);

    if (isPreviewBot) {
      try {
        const res = await fetch(target, { redirect: "follow" });
        const html = await res.text();

        const meta = extractMeta(html, target);

        const previewHtml = buildPreviewHtml(meta, target);
        return new Response(previewHtml, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      } catch (e) {
        // En cas d’échec, on renvoie juste une redirection
        return Response.redirect(target, 302);
      }
    }

    // Visiteurs humains : redirection transparente
    return Response.redirect(target, 302);
  },
};

/** Détection basique des bots d’unfurl (WhatsApp, Slack, iMessage, Facebook, etc.) */
function looksLikeUnfurlBot(ua) {
  const signatures = [
    "whatsapp",
    "facebookexternalhit",
    "twitterbot",
    "slackbot",
    "linkedinbot",
    "discordbot",
    "telegrambot",
    "skypeuripreview",
    "vkshare",
    "pinterest",
    "applebot",
    "googlebot",
    "bingbot",
    "duckduckbot",
    "yandexbot",
    "ia_archiver",
    "embedly",
    "quora link preview",
    "iframely",
  ];
  return signatures.some(sig => ua.includes(sig));
}

/** Extrait title/description + balises OG/Twitter depuis le HTML cible */
function extractMeta(html, targetUrl) {
  const get = (regex, flags = "i") => {
    const m = html.match(new RegExp(regex, flags));
    return m ? (m[1] || m[2])?.trim() : null;
  };

  // Title & meta name=description
  const title = get("<title>([\\s\\S]*?)<\\/title>");
  const metaDesc = get(
    '<meta\\s+name=["\']description["\']\\s+content=["\']([\\s\\S]*?)["\']\\s*\\/?>'
  );

  // Open Graph
  const ogTitle = get(
    '<meta\\s+property=["\']og:title["\']\\s+content=["\']([\\s\\S]*?)["\']\\s*\\/?>'
  );
  const ogDesc = get(
    '<meta\\s+property=["\']og:description["\']\\s+content=["\']([\\s\\S]*?)["\']\\s*\\/?>'
  );
  const ogImage = get(
    '<meta\\s+property=["\']og:image["\']\\s+content=["\']([\\s\\S]*?)["\']\\s*\\/?>'
  );
  const ogType = get(
    '<meta\\s+property=["\']og:type["\']\\s+content=["\']([\\s\\S]*?)["\']\\s*\\/?>'
  );
  const ogUrl = get(
    '<meta\\s+property=["\']og:url["\']\\s+content=["\']([\\s\\S]*?)["\']\\s*\\/?>'
  );

  // Twitter
  const twTitle = get(
    '<meta\\s+name=["\']twitter:title["\']\\s+content=["\']([\\s\\S]*?)["\']\\s*\\/?>'
  );
  const twDesc = get(
    '<meta\\s+name=["\']twitter:description["\']\\s+content=["\']([\\s\\S]*?)["\']\\s*\\/?>'
  );
  const twImage = get(
    '<meta\\s+name=["\']twitter:image["\']\\s+content=["\']([\\s\\S]*?)["\']\\s*\\/?>'
  );
  const twCard = get(
    '<meta\\s+name=["\']twitter:card["\']\\s+content=["\']([\\s\\S]*?)["\']\\s*\\/?>'
  );

  // Fallbacks corrects
  return {
    title: ogTitle || twTitle || title || "",
    description: ogDesc || twDesc || metaDesc || "",
    image: ogImage || twImage || "",
    ogType: ogType || "website",
    ogUrl: ogUrl || targetUrl,
    twitterCard: twCard || "summary_large_image",
    canonical: ogUrl || targetUrl,
  };
}

/** Construit une page HTML minimale avec les mêmes balises pour l’unfurl */
function buildPreviewHtml(meta, targetUrl) {
  const esc = s =>
    (s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="canonical" href="${esc(meta.canonical)}" />
<title>${esc(meta.title)}</title>
<meta name="description" content="${esc(meta.description)}">

<meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:type" content="${esc(meta.ogType)}">
<meta property="og:url" content="${esc(meta.ogUrl)}">
${meta.image ? `<meta property="og:image" content="${esc(meta.image)}">` : ""}

<meta name="twitter:card" content="${esc(meta.twitterCard)}">
<meta name="twitter:title" content="${esc(meta.title)}">
<meta name="twitter:description" content="${esc(meta.description)}">
${meta.image ? `<meta name="twitter:image" content="${esc(meta.image)}">` : ""}

<meta http-equiv="refresh" content="0; url=${esc(targetUrl)}">
</head>
<body>
If you are not redirected, <a href="${esc(targetUrl)}">click here</a>.
</body>
</html>`;
}
