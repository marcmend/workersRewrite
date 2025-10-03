// worker.js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    // 1) Endpoint lecture des logs
    if (pathname === "/_logs") {
      const token = url.searchParams.get("token");
      if (!token || token !== env.LOG_READ_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
      const list = await env.LOGS.list({ prefix: "log-" });
      const items = [];
      for (const k of list.keys) {
        const v = await env.LOGS.get(k.name);
        if (v) items.push(JSON.parse(v));
      }
      return json(items);
    }

    // 2) Résolution de la cible
    const target = resolveTarget(url);
    if (!target) return new Response("Missing ?target=…", { status: 400 });

    // 3) Log minimal (KV)
    const cf = request.cf ?? {};
    const entry = {
      ts: new Date().toISOString(),
      target,
      ip: request.headers.get("cf-connecting-ip"),
      ua: request.headers.get("user-agent"),
      referer: request.headers.get("referer"),
      geo: { country: cf.country, city: cf.city, region: cf.region, asn: cf.asn },
    };
    ctx.waitUntil(
      env.LOGS.put(
        `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        JSON.stringify(entry)
      )
    );

    // 4) Preview mirroring pour les bots d’unfurl (ou ?preview=1)
    const forcePreview = url.searchParams.get("preview") === "1";
    const isPreviewBot = looksLikeUnfurlBot((entry.ua || "").toLowerCase());
    if (forcePreview || isPreviewBot) {
      try {
        const meta = await fetchAndExtract(target, request);
        return new Response(buildPreviewHtml(meta, target), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      } catch {
        // fallback => redirection
        return Response.redirect(target, 302);
      }
    }

    // 5) Visiteurs humains => redirection
    return Response.redirect(target, 302);
  },
};

/** Mapping des URLs courtes => Instagram */
function resolveTarget(url) {
  // priorité au paramètre explicite
  const qTarget = url.searchParams.get("target");
  if (qTarget) return qTarget;

  // /p/:id
  const mPost = url.pathname.match(/^\/p\/([A-Za-z0-9_-]+)\/?$/);
  if (mPost) return `https://www.instagram.com/p/${mPost[1]}/`;

  // /reel/:id ou /reels/:id
  const mReel = url.pathname.match(/^\/reels?\/([A-Za-z0-9_-]+)\/?$/);
  if (mReel) return `https://www.instagram.com/reel/${mReel[1]}/`;

  // (tu peux ajouter d'autres patterns ici : /tv/:id, /stories/:user/:id, etc.)
  return null;
}

function looksLikeUnfurlBot(ua) {
  const sigs = [
    "whatsapp", "facebookexternalhit", "twitterbot", "slackbot", "linkedinbot",
    "discordbot", "telegrambot", "skypeuripreview", "vkshare", "pinterest",
    "applebot", "embedly", "iframely", "quora link preview",
    "googlebot", "bingbot", "duckduckbot", "yandexbot", "ia_archiver",
  ];
  return sigs.some(s => ua.includes(s));
}

async function fetchAndExtract(targetUrl, request) {
  const res = await fetch(targetUrl, {
    redirect: "follow",
    headers: {
      // certains sites renvoient un HTML différent selon l’UA/langue :
      "user-agent": request.headers.get("user-agent") || "facebookexternalhit/1.1",
      "accept-language": request.headers.get("accept-language") || "en",
    },
  });
  const html = await res.text();

  // Collect via HTMLRewriter
  let collected = {};
  const rewriter = new HTMLRewriter()
    .on("title", {
      text(t) { collected._title = (collected._title || "") + t.text; }
    })
    .on("meta", {
      element(e) {
        const name = e.getAttribute("name");
        const prop = e.getAttribute("property");
        const content = e.getAttribute("content");
        if (!content) return;
        const key = (prop || name || "").toLowerCase();
        collected[key] = content;
      }
    })
    .on('link[rel="canonical"]', { element(e) { collected.canonical = e.getAttribute("href"); } });

  await rewriter.transform(new Response(html)).arrayBuffer();

  const meta = {
    title: collected["og:title"] || collected["twitter:title"] || collected._title || "",
    description: collected["og:description"] || collected["twitter:description"] || collected["description"] || "",
    image: collected["og:image"] || collected["twitter:image"] || "",
    ogType: collected["og:type"] || "website",
    ogUrl: collected["og:url"] || targetUrl,
    twitterCard: collected["twitter:card"] || (collected["og:image"] ? "summary_large_image" : "summary"),
    canonical: collected.canonical || collected["og:url"] || targetUrl,
  };

  // fallback regex pour <title> si besoin
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
</head><body>If you are not redirected, <a href="${esc(targetUrl)}">open on Instagram</a>.</body></html>`;
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
