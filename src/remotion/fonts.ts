// Bundled, offline fonts (OFL / Apache licensed via Fontsource) + a render gate that
// waits until every font a spec uses has loaded, so no frame renders in a fallback font.
import "@fontsource-variable/inter";
import "@fontsource-variable/montserrat";
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "@fontsource/poppins/800.css";
import "@fontsource/poppins/900.css";
import "@fontsource/anton";
import "@fontsource/bebas-neue";
import "@fontsource-variable/oswald";
import "@fontsource/bangers";
import "@fontsource-variable/playfair-display";
import "@fontsource/permanent-marker";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/cairo";
import "@fontsource/tajawal/400.css";
import "@fontsource/tajawal/700.css";
import "@fontsource/tajawal/800.css";
import "@fontsource/tajawal/900.css";
import "@fontsource-variable/jetbrains-mono";
import { useEffect, useRef, useState } from "react";
import { continueRender, delayRender } from "remotion";
import { FONT_CSS } from "../shared/catalog";
import type { FontName, Spec } from "../shared/spec";

export function fontsUsed(spec: Spec): FontName[] {
  const set = new Set<FontName>([spec.captions.font, "Cairo", "Montserrat"]);
  for (const o of spec.overlays) {
    if (o.type === "text") set.add(o.style.font);
    if (o.type === "template" && o.font) set.add(o.font);
  }
  return [...set];
}

/** Characters that will be drawn — lets the browser fetch the right unicode subsets (e.g. Arabic). */
export function sampleText(spec: Spec, extra: string): string {
  const parts = [extra];
  for (const o of spec.overlays) {
    if (o.type === "text") parts.push(o.text);
    if (o.type === "template") parts.push(...Object.values(o.props).map(String));
  }
  return (parts.join(" ") + " ABCabc0123").slice(0, 4000);
}

/** Blocks rendering (delayRender) until the fonts are loaded. Runs once per mount. */
export function useFontsReady(fonts: FontName[], text: string) {
  const [handle] = useState(() => delayRender("Loading fonts", { timeoutInMilliseconds: 30000 }));
  const continued = useRef(false);
  useEffect(() => {
    const release = () => {
      if (!continued.current) {
        continued.current = true;
        continueRender(handle);
      }
    };
    const loads = fonts.flatMap((f) =>
      [400, 800].map((w) => document.fonts.load(`${w} 48px "${FONT_CSS[f]}"`, text).catch(() => [])),
    );
    Promise.all(loads).finally(release);
    return release;
    // Intentionally once per mount: later spec edits only add fonts the preview loads lazily.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
