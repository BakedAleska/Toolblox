import { createCn } from "cn/config";

/** Merges class names. Registers the custom utilities: font sizes from `theme.css`, which would
 * otherwise be read as text colors, and `max-h-menu` from `index.css`. */
export const cn = createCn({ extend: { classGroups: { "font-size": [{ text: ["2xs", "button"] }], "max-h": [{ "max-h": ["menu"] }] } } });
