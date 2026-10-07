import { useEffect, useState } from "react";
import { Editor } from "./Editor";
import { Home } from "./Home";
import { Music } from "./Music";
import { NightShift } from "./NightShift";

type Route = { view: "home" } | { view: "music" } | { view: "project"; id: string } | { view: "night"; id: string | null };

function route(): Route {
  const p = /^#\/p\/([a-z0-9]+)/.exec(location.hash);
  if (p) return { view: "project", id: p[1]! };
  const n = /^#\/night(?:\/([a-z0-9]+))?/.exec(location.hash);
  if (n) return { view: "night", id: n[1] ?? null };
  if (location.hash.startsWith("#/music")) return { view: "music" };
  return { view: "home" };
}

export function App() {
  const [r, setR] = useState<Route>(route);
  useEffect(() => {
    const on = () => setR(route());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  if (r.view === "project") return <Editor key={r.id} id={r.id} />;
  if (r.view === "night") return <NightShift id={r.id} />;
  if (r.view === "music") return <Music />;
  return <Home />;
}

export const goMusic = () => {
  location.hash = "#/music";
};

export const go = (projectId: string | null) => {
  location.hash = projectId ? `#/p/${projectId}` : "#/";
};

export const goNight = (batchId?: string | null) => {
  location.hash = batchId ? `#/night/${batchId}` : "#/night";
};
