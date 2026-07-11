// Shared DOM builder for the missions front-end.
//
// el(tag, props, children):
//   props: class | text | html | style(object) | on<Event>(fn) | dataset(object) |
//          title/href/src/alt/rel/target/loading/decoding/referrerPolicy (assigned as
//          properties) | anything else via setAttribute. null/undefined props are skipped.
//   children: a node or string (or an array of them); null/false entries are skipped.
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "style") Object.assign(node.style, v);
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "title" || k === "href" || k === "src" || k === "alt" || k === "rel" || k === "target" || k === "loading" || k === "decoding" || k === "referrerPolicy") {
      node[k] = v;
    } else if (k === "dataset") {
      Object.assign(node.dataset, v);
    } else {
      node.setAttribute(k, v);
    }
  }
  if (children) {
    const list = Array.isArray(children) ? children : [children];
    for (const c of list) {
      if (c == null || c === false) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
  }
  return node;
}
