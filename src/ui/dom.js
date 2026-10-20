//
// DOM helpers, text only goes in through textContent
//

export const $ = (id) => document.getElementById(id);

// (String, {class?, ...attributes}, String | [Node]) -> Element
export function el(tag, attributes = {}, content) {
    const node = document.createElement(tag);
    for(const [k, v] of Object.entries(attributes)) {
        if(k === 'class') node.className = v;
        else node.setAttribute(k, String(v));
    }
    if(Array.isArray(content)) node.append(...content);
    else if(content !== undefined) node.textContent = String(content);
    return node;
}

// Number -> String, 75 -> '1:15', 3725 -> '1:02:05'
export function formatDuration(seconds) {
    if(!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
