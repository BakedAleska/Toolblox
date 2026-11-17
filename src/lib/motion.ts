/** Entrance and exit for floating layers: a quick decelerating fade and scale in, and a shorter
 * accelerating exit. Reduced motion shortens both to an instant change. */
export const floatingMotion = "duration-200 ease-enter data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-closed:duration-100 data-closed:ease-exit";

/** `floatingMotion` for popups positioned against an anchor. They grow from the anchor and slide a
 * few pixels along the side they open on. */
export const anchoredMotion = `${floatingMotion} origin-(--transform-origin) data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=inline-start]:slide-in-from-right-1 data-[side=inline-end]:slide-in-from-left-1 data-[side=bottom]:slide-out-to-top-1 data-[side=top]:slide-out-to-bottom-1 data-[side=left]:slide-out-to-right-1 data-[side=right]:slide-out-to-left-1 data-[side=inline-start]:slide-out-to-right-1 data-[side=inline-end]:slide-out-to-left-1`;

/** Hover motion for surfaces that open or choose something: they rise a little, brighten their
 * ring, and sink when pressed. */
export const lift = "transition-[translate,scale,background-color,box-shadow] duration-300 ease-spring hover:-translate-y-0.5 hover:ring-foreground/15 active:translate-y-0 active:scale-[0.99]";
