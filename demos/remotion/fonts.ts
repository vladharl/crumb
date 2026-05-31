// Real brand fonts for the reel, matching the dashboard's type system
// (apps/dashboard/app/layout.tsx + globals.css):
//   - Display: General Sans (vendored woff2 in ./fonts, free ITF license)
//   - Body:    Inter (via @remotion/google-fonts)
// Both register their own delayRender internally, so frames wait for the faces
// to be ready before rendering — no FOUT in the output video.
import { staticFile } from "remotion";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadLocalFont } from "@remotion/fonts";

// Inter (body) — google-fonts handles fetch + readiness.
const inter = loadInter("normal", {
  weights: ["400", "500", "600", "700"],
  subsets: ["latin"],
});
export const BODY = inter.fontFamily;

// General Sans (display) — vendored so renders are offline-reproducible.
export const DISPLAY = "General Sans";
for (const [weight, file] of [
  ["400", "fonts/GeneralSans-400.woff2"],
  ["500", "fonts/GeneralSans-500.woff2"],
  ["600", "fonts/GeneralSans-600.woff2"],
  ["700", "fonts/GeneralSans-700.woff2"],
] as const) {
  // Fire-and-forget: @remotion/fonts brackets each load in delayRender/
  // continueRender, so the renderer blocks until every weight is ready.
  void loadLocalFont({ family: DISPLAY, url: staticFile(file), weight, style: "normal" });
}
