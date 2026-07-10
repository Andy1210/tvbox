import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Guard against locale drift: the two locales must define the same keys, and
// every key must actually be used in the source (statically via t("a.b"), or
// under a known dynamic prefix). Deleting a used string or leaving a dead one
// both fail here.
const HERE = path.dirname(fileURLToPath(import.meta.url)); // launcher/src/lib
const SRC = path.resolve(HERE, ".."); // launcher/src
const LOCALES = path.join(SRC, "locales");
const DYNAMIC = ["_meta.", "greeting.", "ambient.wx.", "settingsCat.", "remote.action.", "remote.power.", "keymap."]; // built at runtime (Clock, Ambient weather, Settings categories, remap actions, power options, keyboard-layout names)

function flatten(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === "object" ? flatten(v as Record<string, unknown>, key) : [key];
  });
}
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return p === LOCALES ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}
const isDynamic = (k: string) => DYNAMIC.some((d) => (d.endsWith(".") ? k.startsWith(d) : k === d));

const en = JSON.parse(fs.readFileSync(path.join(LOCALES, "en.json"), "utf8"));
const hu = JSON.parse(fs.readFileSync(path.join(LOCALES, "hu.json"), "utf8"));
// app-sdk components the launcher renders (PinGate) reference launcher locale
// keys too - scan the sdk source as well so those keys don't read as dead.
const SDK = path.resolve(HERE, "../../../app-sdk/src");
const source = [...walk(SRC), ...walk(SDK)].map((f) => fs.readFileSync(f, "utf8")).join("\n");

describe("locale hygiene", () => {
  it("en and hu define identical key sets", () => {
    expect(flatten(en).sort()).toEqual(flatten(hu).sort());
  });
  it("has no unused keys (every key is referenced in source or dynamic)", () => {
    const dead = flatten(en).filter((k) => !isDynamic(k) && !source.includes(`"${k}"`) && !source.includes(`'${k}'`));
    expect(dead).toEqual([]);
  });
});
