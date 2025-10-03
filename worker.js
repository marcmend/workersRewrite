export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const target = url.searchParams.get("target");
    const forcePreview = url.searchParams.get("preview") === "1";

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
      return json(items);
    }

    if (!target) return new Response("Missing ?target=…", { status: 400 });

    // Log minimal
    const cf = request.cf ?? {};
    const entry = {
      ts: new Date().toISOString(),
      target,
      ip: request.headers.get("cf-connecting-ip"),
      ua: request.headers.get("user-agent"),
      ref: request.headers.get("referer"),
      geo: { country: cf.country, city: cf.city, region: cf.region, asn: cf.asn },
    };
    ctx.waitUntil(env.LOGS.put(`log-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, JSON.stringify(entry)));

    const ua = (entry.ua || "").toLowerCase();
    const isPreviewBot = looksLikeUnfurlBot(ua);
    const shouldServePreview = forcePreview || isPreviewBot;

    if (url.pathname === "/_debug" && shouldServePreview) {
      const meta = await fetchAndExtract(target, request);
      return json(meta);
    }

    if (shouldServePreview) {
      try {
        const meta = await fetchAndExtract(target, request);
        return new Response(buildPreviewHtml(meta, target), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      } catch {
        return Response.redirect(target, 302);
      }
    }

    // Visiteurs humains => redirige
    return Response.redirect(target, 302);
  },
};

function looksLikeUnfurlBot(ua) {
  const sigs = [
    "whatsapp", "facebookexternalhit", "twitterbot", "slackbot", "linkedinbot",
    "discordbot", "telegrambot", "skypeuripreview", "vkshare", "pinterest",
    "applebot", "embedly", "iframely", "quora link preview",
    // moteurs de recherche (facultatif) :
    "googlebot", "bingbot", "duckduckbot", "yandexbot", "ia_archiver",
  ];
  return sigs.some(s => ua.includes(s));
}

async function fetchAndExtract(targetUrl, request) {
  // Forward quelques headers pour obtenir un HTML “réaliste”
  const f = await fetch(targetUrl, {
    redirect: "follow",
    headers: {
      "user-agent": request.headers.get("user-agent") || "facebookexternalhit/1.1",
      "accept-language": request.headers.get("accept-language") || "en",
    },
  });
  const html = await f.text();

  // 1) Essai avec HTMLRewriter (robuste)
  let meta = { title: "", description: "", image: "", ogType: "website", ogUrl: targetUrl, twitterCard: "summary_large_image", canonical: targetUrl };
  const collect = {};
  const rewriter = new HTMLRewriter()
    .on("title", {
      text(t) { collect._title = (collect._title || "") + t.text; }
    })
    .on('meta', {
      element(e) {
        const name = e.getAttribute('name');
        const prop = e.getAttribute('property');
        const content = e.getAttribute('content');
        if (!content) return;
        const key = (prop || name || "").toLowerCase();
        collect[key] = content;
      }
    })
    .on('link[rel="canonical"]', { element(e){ collect.canonical = e.getAttribute('href'); } });

  // HTMLRewriter nécessite un stream/Response
  const rwResponse = new Response(html);
  await rewriter.transform(rwResponse).arrayBuffer(); // force le passage

  meta.title = collect["og:title"] || collect["twitter:title"] || collect._title || "";
  meta.description = collect["og:description"] || collect["twitter:description"] || collect["description"] || "";
  meta.image = collect["og:image"] || collect["twitter:image"] || "";
  meta.ogType = collect["og:type"] || "website";
  meta.ogUrl = collect["og:url"] || targetUrl;
  meta.twitterCard = collect["twitter:card"] || (meta.image ? "summary_large_image" : "summary");
  meta.canonical = collect.canonical || meta.ogUrl || targetUrl;

  // 2) Fallback regex si nécessaire (si rien trouvé)
  if (!meta.title) {
    const m = html.match(/<title>([\s\S]*?)<\/title>/i);
    if (m) meta.title = m[1].trim();
  }

  return meta;
}

function buildPreviewHtml(meta, targetUrl) {
  const esc = s => (s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  return `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="canonical" href="${esc(meta.canonical)}">
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
</head><body>If you are not redirected, <a href="${esc(targetUrl)}">click here</a>.</body></html>`;
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
