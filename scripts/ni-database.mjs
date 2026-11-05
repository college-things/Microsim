// Read-only access to the user's installed NI Jet database. No database ships here.
import MDBReader from "mdb-reader";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, basename } from "node:path";
const text = (v) => typeof v === "string" ? v : "";
const lines = (v) => text(v).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
export class NiCatalog {
  constructor(tables, sourceName = "NI database") {
    this.tables = tables;
    this.sourceName = sourceName;
    this.components = tables("SYS_COMPONENT");
    this.families = new Map(tables("SYS_CONFIGURATION").map((r) => [r.Family_ID, r]));
    this.byId = new Map(this.components.map((c) => [String(c.Component_ID), c]));
    this.mapping = undefined; this.models = undefined;
  }
  summary() { return { name: this.sourceName, count: this.components.length }; }
  search(query = "", offset = 0, limit = 50) {
    if (typeof query !== "string" || query.length > 200) throw new Error("Search must be at most 200 characters.");
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches = this.components.filter((c) => {
      const haystack = `${c.Component_Name} ${c.Manufacturer} ${c.Function ?? ""} ${this.families.get(c.Family_ID)?.Family_Name ?? ""}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    const count = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
    return { total: matches.length, offset: start, items: matches.slice(start, start + count).map((c) => ({ id: String(c.Component_ID), name: c.Component_Name, manufacturer: c.Manufacturer, family: this.families.get(c.Family_ID)?.Family_Name ?? "", pins: c.Pin_Number, sections: c.Sec_Number })) };
  }
  part(id, requestedModel) {
    const c = this.byId.get(String(id));
    if (!c) throw new Error("Component is not in the opened database.");
    if (!this.mapping) {
      this.mapping = new Map();
      for (const row of this.tables("SYS_MAPPING_COMP_MODEL")) {
        const key = String(row.Component_ID);
        if (!this.mapping.has(key)) this.mapping.set(key, []);
        this.mapping.get(key).push(row);
      }
    }
    const mappings = this.mapping.get(String(id)) ?? [];
    const choices = [...new Set(mappings.map((m) => text(m.Model_ID)).filter(Boolean))];
    if (!choices.length) throw new Error("This component has no stored SPICE model mapping. Place it in a native circuit and import that circuit instead.");
    const model = requestedModel ?? choices.find((m) => m.toLowerCase() === text(c.Component_Name).toLowerCase()) ?? choices[0];
    if (!choices.includes(model)) throw new Error("Choose one of this component's model variants.");
    const selected = mappings.filter((m) => m.Model_ID === model).sort((a, b) => a.Sec_Order - b.Sec_Order);
    if (selected.some((m) => /#\d|%S\d/.test(text(m.Template)))) throw new Error("This part requires generated instance parameters; import it from a native .ms14 circuit to retain those parameters.");
    if (!this.models) {
      this.models = new Map();
      for (const row of this.tables("SYS_MODEL")) {
        const key = text(row.MODEL_ID).toLowerCase();
        if (!this.models.has(key)) this.models.set(key, []);
        this.models.get(key).push(row);
      }
    }
    const definitions = new Map();
    const pending = [model.toLowerCase()];
    while (pending.length) {
      const key = pending.pop();
      if (definitions.has(key)) continue;
      const options = this.models.get(key);
      if (!options?.length) throw new Error(`Missing model definition: ${key}.`);
      const row = options.find((r) => r.Manufacturer === c.Manufacturer) ?? options.find((r) => r.Manufacturer === "Generic") ?? options[0];
      const body = text(row.DATA).replace(/\r\n?/g, "\n").replace(/_uc1([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      if (!/^\s*\.(model|subckt)\b/im.test(body)) throw new Error(`Model ${key} is not stored as a SPICE definition.`);
      definitions.set(key, body);
      for (const token of body.split(/[\s(),={}]+/)) {
        const dependency = token.toLowerCase();
        if (this.models.has(dependency) && !definitions.has(dependency)) pending.push(dependency);
      }
      if (definitions.size > 1000) throw new Error("The model dependency graph is too large.");
    }
    const pinNames = [...new Set(lines(c.Pinout))];
    if (!pinNames.length || pinNames.length > 1024) throw new Error("The component has no usable pin list.");
    return { id: String(id), name: c.Component_Name, manufacturer: c.Manufacturer, family: this.families.get(c.Family_ID)?.Family_Name ?? "", prefix: text(this.families.get(c.Family_ID)?.Template).replace(/%d.*$/, "") || "U", model, choices, pinNames, templates: selected.map((m) => text(m.Template)), definitions: [...definitions.values()].join("\n\n"), source: this.sourceName };
  }
}
export async function openNiDatabase(filename) {
  if (typeof filename !== "string" || ![".prd", ".usr", ".prj", ".mdb"].includes(extname(filename).toLowerCase())) throw new Error("Choose an NI .prd, .usr, .prj or Access .mdb database.");
  const path = resolve(filename), info = await stat(path);
  if (!info.isFile() || info.size > 512 * 1024 * 1024) throw new Error("Database must be a file smaller than 512 MB.");
  const reader = new MDBReader(await readFile(path));
  const names = new Set(reader.getTableNames());
  if (!names.has("SYS_COMPONENT") || !names.has("SYS_MAPPING_COMP_MODEL") || !names.has("SYS_MODEL")) throw new Error("This file does not have the supported NI component database schema.");
  const tables = (name) => names.has(name) ? reader.getTable(name).getData() : [];
  return new NiCatalog(tables, basename(path));
}
