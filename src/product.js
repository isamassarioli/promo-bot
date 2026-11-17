// Lê título, descrição e foto da página do produto (tags Open Graph), para enriquecer a mensagem.

const decode = (s = '') =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();

function meta(html, names) {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${name}["']`,
      'i',
    );
    const m = html.match(re);
    if (m) return decode(m[1] || m[2]);
  }
  return null;
}

/** Retorna { title, description, image } (campos podem vir null). Nunca lança erro. */
export async function fetchProductInfo(url, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const empty = { title: null, description: null, image: null };
  if (!url) return empty;
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        'accept-language': 'pt-BR,pt;q=0.9',
      },
    });
    const html = (await res.text()).slice(0, 3_000_000);
    // Amazon não usa Open Graph: pega a foto principal (data-old-hires) e o <title>.
    const image =
      meta(html, ['og:image', 'twitter:image']) ||
      decode(html.match(/data-old-hires="(https:[^"]+)"/)?.[1] || '') ||
      null;
    const pageTitle = decode(html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '').split(/ : Amazon| \| Mercado Livre/)[0] || null;
    return {
      title: meta(html, ['og:title', 'twitter:title']) || pageTitle,
      description: meta(html, ['og:description', 'description'])?.slice(0, 600) || null,
      // WhatsApp não aceita .webp como foto; o Mercado Livre serve a mesma imagem em .jpg.
      image: image && /^https?:\/\//.test(image) ? image.replace(/(mlstatic\.com\/.+)\.webp$/, '$1.jpg') : null,
    };
  } catch {
    return empty;
  }
}
