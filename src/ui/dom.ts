type Child = Node | string | null | undefined | false;
type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], 'style' | 'dataset'>> & {
  class?: string;
  style?: Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  attrs?: Record<string, string>;
};

/** Tiny DOM builder: h('button', { class: 'x', onclick }, 'Label'). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props<K> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: className, style, dataset, attrs, ...rest } = props;
  if (className) el.className = className;
  if (style) Object.assign(el.style, style);
  if (dataset) Object.assign(el.dataset, dataset);
  if (attrs) for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  Object.assign(el, rest);
  for (const child of children) if (child) el.append(child);
  return el;
}

/** Parses a trusted, static SVG string (icons) into an element. */
export function svg(markup: string): SVGElement {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild as SVGElement;
}
