// App icon from the manifest `icon` field (inline SVG). Rendered as an <img> with
// a data: URI - NOT dangerouslySetInnerHTML. SVG loaded via <img> cannot execute
// script or honor javascript:/on* handlers, so a (possibly third-party) manifest
// icon can't XSS the launcher, without needing a sanitizer to be exhaustive.
export function Icon({ svg, className }: { svg?: string; className?: string }) {
  if (!svg || !svg.includes("<svg")) return null;
  // As a standalone <img> the SVG is parsed as an XML document, which REQUIRES the
  // namespace; manifest icons omit it (fine for inline HTML), so add it if missing.
  const doc = svg.includes("xmlns") ? svg : svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  return <img src={"data:image/svg+xml," + encodeURIComponent(doc)} alt="" className={className} />;
}
