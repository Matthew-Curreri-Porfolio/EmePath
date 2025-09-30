import { stripTags } from './util.mjs';

export function toDoc({
  url,
  source,
  title,
  html,
  text,
  summary,
  published_at,
  lang,
  license,
  tags,
}) {
  const body = text || stripTags(html || '');
  return {
    id: `${source}:${url}`,
    url,
    source,
    title: title || (body ? body.slice(0, 80) : ''),
    summary: summary || '',
    body,
    published_at: published_at || null,
    lang: lang || null,
    license: license || null,
    tags: tags || [],
  };
}
