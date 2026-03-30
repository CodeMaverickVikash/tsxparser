/**
 * frameworkDetector.ts — Framework-Aware Pattern Detection
 *
 * ─── Responsibilities ─────────────────────────────────────────────────────────
 *
 *  Detects which frontend framework (React / Angular / Vue) a symbol belongs to
 *  by inspecting parsed AST metadata from astParser.ts.
 *
 *  React patterns detected:
 *    • Functional components  — exported arrow/function returning JSX, name starts with uppercase
 *    • useState / useEffect   — hook call expressions
 *    • Custom hooks           — functions whose name starts with "use"
 *    • React.memo / forwardRef / createContext
 *
 *  Angular patterns detected:
 *    • @Component / @NgModule / @Injectable / @Directive / @Pipe decorators
 *    • Class names ending in Component / Service / Module / Pipe / Guard / Resolver
 *    • Constructor injection patterns (typed parameters in constructor)
 *
 *  Vue patterns detected:
 *    • defineComponent() call
 *    • defineProps / defineEmits / defineExpose (Composition API macros)
 *    • ref() / reactive() / computed() / watch() / onMounted() etc.
 *    • createApp()
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *  detectFramework(parsed)         → FrameworkInfo   (file-level)
 *  classifySymbol(sym, parsed)     → FrameworkTag    (symbol-level)
 *  tagAllSymbols(parsed)           → Map<name, FrameworkTag[]>
 */

import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import {
  ParsedFile,
  ParsedFunction,
  ParsedClass,
  ParsedVariable,
  ParsedImport,
} from "./astParser";

// ─── Public types ─────────────────────────────────────────────────────────────

export type Framework = "react" | "angular" | "vue" | "unknown";

export type ReactRole =
  | "functional-component"
  | "hook"
  | "custom-hook"
  | "hoc"
  | "context"
  | "memo"
  | "forward-ref";

export type AngularRole =
  | "component"
  | "service"
  | "module"
  | "directive"
  | "pipe"
  | "guard"
  | "resolver"
  | "interceptor";

export type VueRole =
  | "component"
  | "composable"
  | "reactive-ref"
  | "computed"
  | "watch"
  | "lifecycle-hook";

export interface FrameworkTag {
  framework: Framework;
  role?: ReactRole | AngularRole | VueRole;
  /** Human-readable label, e.g. "React functional component" */
  label: string;
  /** Icon ID for VS Code ThemeIcon */
  icon: string;
}

export interface FrameworkInfo {
  /** Primary framework detected in this file */
  primary: Framework;
  /** Confidence: 0–100 */
  confidence: number;
  /** All frameworks detected (a file may mix patterns) */
  detected: Set<Framework>;
  /** Tags keyed by symbol name */
  symbolTags: Map<string, FrameworkTag>;
}

// ─── Framework import signatures ─────────────────────────────────────────────

const REACT_IMPORT_MODULES = new Set([
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react-router-dom",
  "react-redux",
]);
const ANGULAR_IMPORT_MODULES = new Set([
  "@angular/core",
  "@angular/common",
  "@angular/router",
  "@angular/forms",
  "@angular/platform-browser",
]);
const VUE_IMPORT_MODULES = new Set([
  "vue",
  "@vue/composition-api",
  "vue-router",
  "pinia",
  "vuex",
]);

const REACT_HOOKS = new Set([
  "useState",
  "useEffect",
  "useContext",
  "useReducer",
  "useCallback",
  "useMemo",
  "useRef",
  "useImperativeHandle",
  "useLayoutEffect",
  "useDebugValue",
  "useId",
  "useDeferredValue",
  "useTransition",
  "useSyncExternalStore",
  "useInsertionEffect",
]);

const VUE_COMPOSITION_APIS = new Set([
  "ref",
  "reactive",
  "computed",
  "watch",
  "watchEffect",
  "onMounted",
  "onUnmounted",
  "onBeforeMount",
  "onBeforeUnmount",
  "onUpdated",
  "onBeforeUpdate",
  "onActivated",
  "onDeactivated",
  "provide",
  "inject",
  "readonly",
  "isRef",
  "unref",
  "toRef",
  "toRefs",
  "shallowRef",
  "shallowReactive",
  "markRaw",
  "nextTick",
  "defineComponent",
  "defineProps",
  "defineEmits",
  "defineExpose",
  "createApp",
  "createRouter",
  "useRoute",
  "useRouter",
  "useStore",
]);

const ANGULAR_DECORATORS = new Set([
  "Component",
  "NgModule",
  "Injectable",
  "Directive",
  "Pipe",
  "Input",
  "Output",
  "HostListener",
  "HostBinding",
  "ViewChild",
  "ViewChildren",
  "ContentChild",
  "ContentChildren",
]);

// ─── Main entry: file-level detection ────────────────────────────────────────

/**
 * Analyse a ParsedFile and return framework metadata for the file and all
 * symbols within it.
 */
export function detectFramework(parsed: ParsedFile): FrameworkInfo {
  const detected = new Set<Framework>();
  const symbolTags = new Map<string, FrameworkTag>();

  // ── 1. Import-based heuristic (cheapest, most reliable) ──────────────────
  const importedModules = new Set(parsed.imports.map((i) => i.module));
  const importedNames = collectImportedNames(parsed.imports);

  if (
    [...importedModules].some(
      (m) => REACT_IMPORT_MODULES.has(m) || m.startsWith("react"),
    )
  ) {
    detected.add("react");
  }
  if (
    [...importedModules].some(
      (m) => ANGULAR_IMPORT_MODULES.has(m) || m.startsWith("@angular/"),
    )
  ) {
    detected.add("angular");
  }
  if (
    [...importedModules].some(
      (m) => VUE_IMPORT_MODULES.has(m) || m === "vue" || m.startsWith("@vue/"),
    )
  ) {
    detected.add("vue");
  }

  // ── 2. JSX file extension → strong React signal ───────────────────────────
  const ext = path.extname(parsed.filePath).toLowerCase();
  if (ext === ".jsx" || ext === ".tsx") {
    detected.add("react");
  }

  // ── 3. Symbol-level classification ───────────────────────────────────────
  for (const fn of parsed.functions) {
    const tag = classifyFunction(fn, parsed, importedNames, detected);
    if (tag) symbolTags.set(fn.name, tag);
  }

  for (const cls of parsed.classes) {
    const tag = classifyClass(cls, parsed);
    if (tag) symbolTags.set(cls.name, tag);
  }

  for (const v of parsed.variables) {
    const tag = classifyVariable(v, parsed, importedNames, detected);
    if (tag) symbolTags.set(v.name, tag);
  }

  // ── 4. Collect additional framework signals from symbol tags ──────────────
  for (const tag of symbolTags.values()) {
    if (tag.framework !== "unknown") detected.add(tag.framework);
  }

  // ── 5. Determine primary framework + confidence ───────────────────────────
  const { primary, confidence } = resolvePrimary(detected, parsed, symbolTags);

  return { primary, confidence, detected, symbolTags };
}

// ─── Symbol-level classifiers ─────────────────────────────────────────────────

function classifyFunction(
  fn: ParsedFunction,
  parsed: ParsedFile,
  importedNames: Set<string>,
  detected: Set<Framework>,
): FrameworkTag | null {
  // ── React: custom hooks ──────────────────────────────────────────────────
  if (/^use[A-Z]/.test(fn.name)) {
    return {
      framework: "react",
      role: "custom-hook",
      label: `React custom hook`,
      icon: "symbol-event",
    };
  }

  // ── React: functional component (uppercase name, exported) ───────────────
  if (
    /^[A-Z]/.test(fn.name) &&
    fn.exported &&
    (fn.kind === "arrow" || fn.kind === "function" || fn.kind === "expression")
  ) {
    // Try to confirm via return-type hint or JSX detection
    const looksLikeComponent =
      detected.has("react") ||
      (fn.returnType &&
        /jsx|element|reactnode|reactelement/i.test(fn.returnType)) ||
      importedNames.has("React") ||
      ext(parsed.filePath) === ".tsx" ||
      ext(parsed.filePath) === ".jsx";

    if (looksLikeComponent) {
      return {
        framework: "react",
        role: "functional-component",
        label: `React functional component`,
        icon: "symbol-class",
      };
    }
  }

  // ── Vue: composable (function returning Composition API values) ───────────
  if (detected.has("vue") && /^use[A-Z]/.test(fn.name)) {
    return {
      framework: "vue",
      role: "composable",
      label: `Vue composable`,
      icon: "symbol-event",
    };
  }

  // ── React: HOC — function returning another component ────────────────────
  if (
    detected.has("react") &&
    /^(with|create)[A-Z]/.test(fn.name) &&
    fn.exported
  ) {
    return {
      framework: "react",
      role: "hoc",
      label: `React higher-order component`,
      icon: "symbol-function",
    };
  }

  return null;
}

function classifyClass(
  cls: ParsedClass,
  _parsed: ParsedFile,
): FrameworkTag | null {
  // ── Angular: check for Angular decorator-based class names ───────────────
  // (Decorator text isn't preserved in our ParsedClass, so we rely on
  //  naming conventions + superClass hints as a secondary signal.)

  if (/Component$/.test(cls.name)) {
    return {
      framework: "angular",
      role: "component",
      label: `Angular component`,
      icon: "symbol-class",
    };
  }
  if (/Service$/.test(cls.name)) {
    return {
      framework: "angular",
      role: "service",
      label: `Angular service`,
      icon: "symbol-class",
    };
  }
  if (/Module$/.test(cls.name)) {
    return {
      framework: "angular",
      role: "module",
      label: `Angular module`,
      icon: "symbol-namespace",
    };
  }
  if (/Directive$/.test(cls.name)) {
    return {
      framework: "angular",
      role: "directive",
      label: `Angular directive`,
      icon: "symbol-class",
    };
  }
  if (/Pipe$/.test(cls.name)) {
    return {
      framework: "angular",
      role: "pipe",
      label: `Angular pipe`,
      icon: "symbol-class",
    };
  }
  if (/Guard$/.test(cls.name)) {
    return {
      framework: "angular",
      role: "guard",
      label: `Angular route guard`,
      icon: "shield",
    };
  }
  if (/Resolver$/.test(cls.name)) {
    return {
      framework: "angular",
      role: "resolver",
      label: `Angular resolver`,
      icon: "symbol-class",
    };
  }
  if (/Interceptor$/.test(cls.name)) {
    return {
      framework: "angular",
      role: "interceptor",
      label: `Angular HTTP interceptor`,
      icon: "symbol-class",
    };
  }

  // ── React: class component (extends React.Component / PureComponent) ──────
  if (
    cls.superClass &&
    /^(React\.)?(Component|PureComponent)$/.test(cls.superClass)
  ) {
    return {
      framework: "react",
      role: "functional-component", // closest role — class-based
      label: `React class component`,
      icon: "symbol-class",
    };
  }

  return null;
}

function classifyVariable(
  v: ParsedVariable,
  parsed: ParsedFile,
  importedNames: Set<string>,
  detected: Set<Framework>,
): FrameworkTag | null {
  // ── React hooks ──────────────────────────────────────────────────────────
  if (v.initKind === "hook" && v.hookName) {
    const hookBase = v.hookName.replace(/^React\./, "");

    if (REACT_HOOKS.has(hookBase)) {
      return {
        framework: "react",
        role: "hook",
        label: `React hook (${v.hookName})`,
        icon: "symbol-event",
      };
    }

    // Could be a custom hook usage
    if (/^use[A-Z]/.test(hookBase)) {
      return {
        framework: "react",
        role: "hook",
        label: `React hook usage (${v.hookName})`,
        icon: "symbol-event",
      };
    }
  }

  // ── Vue Composition API ───────────────────────────────────────────────────
  if (v.initKind === "call" || v.initKind === "hook") {
    // Extract the callee from hookName or detail
    const callee = v.hookName ?? extractCalleeFromDetail(v);
    if (callee) {
      const calleeBase = callee.replace(/^Vue\./, "");
      if (VUE_COMPOSITION_APIS.has(calleeBase)) {
        const role = vueRole(calleeBase);
        return {
          framework: "vue",
          role,
          label: `Vue ${calleeBase}()`,
          icon: vueIcon(role),
        };
      }
    }
  }

  // ── React: component stored in variable (arrow/function) ─────────────────
  if (
    (v.initKind === "arrow" || v.initKind === "function") &&
    /^[A-Z]/.test(v.name) &&
    v.exported &&
    (detected.has("react") || importedNames.has("React"))
  ) {
    return {
      framework: "react",
      role: "functional-component",
      label: `React functional component`,
      icon: "symbol-class",
    };
  }

  // ── React: React.memo / React.forwardRef / React.createContext ────────────
  if (v.initKind === "call" && v.detail) {
    if (/^React\.memo|^memo\b/.test(v.detail)) {
      return {
        framework: "react",
        role: "memo",
        label: "React.memo component",
        icon: "symbol-class",
      };
    }
    if (/^React\.forwardRef|^forwardRef\b/.test(v.detail)) {
      return {
        framework: "react",
        role: "forward-ref",
        label: "React.forwardRef component",
        icon: "symbol-class",
      };
    }
    if (/^React\.createContext|^createContext\b/.test(v.detail)) {
      return {
        framework: "react",
        role: "context",
        label: "React context",
        icon: "symbol-constant",
      };
    }
  }

  return null;
}

// ─── Deep AST scan: Angular decorator detection ──────────────────────────────

/**
 * Parse the raw TypeScript source of a file to look for Angular decorators.
 * This is called lazily only when `@angular/core` is detected in imports.
 *
 * Returns a map of className → AngularRole.
 */
export function scanAngularDecorators(
  filePath: string,
): Map<string, AngularRole> {
  const result = new Map<string, AngularRole>();
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return result;
  }

  const ext_ = path.extname(filePath).toLowerCase();
  const kind =
    ext_ === ".tsx"
      ? ts.ScriptKind.TSX
      : ext_ === ".jsx"
        ? ts.ScriptKind.JSX
        : ext_ === ".ts"
          ? ts.ScriptKind.TS
          : ts.ScriptKind.JS;

  const sf = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );

  ts.forEachChild(sf, (node) => {
    if (!ts.isClassDeclaration(node) || !node.name) return;

    const className = node.name.text;

    // Walk modifiers — in TS 4.8+ decorators are on node.modifiers
    const mods = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
    // Also check node.decorators for older TS API compatibility
    const decorators: ts.Decorator[] = [];

    // Collect decorators from modifiers (TS 4.8+)
    for (const mod of mods) {
      if (ts.isDecorator(mod)) decorators.push(mod);
    }

    // Fallback: direct decorators property (TS <4.8)
    const legacyDecorators = (node as any).decorators as
      | ts.NodeArray<ts.Decorator>
      | undefined;
    if (legacyDecorators) {
      for (const d of legacyDecorators) decorators.push(d);
    }

    for (const dec of decorators) {
      const name = decoratorName(dec);
      if (!name) continue;

      let role: AngularRole | null = null;
      if (name === "Component") role = "component";
      else if (name === "NgModule") role = "module";
      else if (name === "Injectable") role = "service";
      else if (name === "Directive") role = "directive";
      else if (name === "Pipe") role = "pipe";

      if (role) {
        result.set(className, role);
        break;
      }
    }
  });

  return result;
}

/**
 * Enrich FrameworkInfo with deep Angular decorator data.
 * Call after detectFramework() when 'angular' is in detected.
 */
export function enrichWithAngularDecorators(
  info: FrameworkInfo,
  filePath: string,
): void {
  if (!info.detected.has("angular")) return;

  const decoratorMap = scanAngularDecorators(filePath);
  for (const [className, role] of decoratorMap) {
    info.symbolTags.set(className, {
      framework: "angular",
      role,
      label: `Angular ${role} (decorator)`,
      icon: "symbol-class",
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function collectImportedNames(imports: ParsedImport[]): Set<string> {
  const names = new Set<string>();
  for (const imp of imports) {
    if (imp.defaultImport) names.add(imp.defaultImport);
    if (imp.namespaceImport) names.add(imp.namespaceImport);
    for (const n of imp.named) {
      names.add(n.alias ?? n.name);
    }
  }
  return names;
}

function resolvePrimary(
  detected: Set<Framework>,
  parsed: ParsedFile,
  tags: Map<string, FrameworkTag>,
): { primary: Framework; confidence: number } {
  if (detected.size === 0) return { primary: "unknown", confidence: 0 };

  const scores: Record<Framework, number> = {
    react: 0,
    angular: 0,
    vue: 0,
    unknown: 0,
  };

  // Score based on imports
  for (const imp of parsed.imports) {
    if (REACT_IMPORT_MODULES.has(imp.module) || imp.module.startsWith("react"))
      scores.react += 10;
    if (ANGULAR_IMPORT_MODULES.has(imp.module)) scores.angular += 10;
    if (VUE_IMPORT_MODULES.has(imp.module)) scores.vue += 10;
  }

  // Score based on symbol tags
  for (const tag of tags.values()) {
    if (tag.framework !== "unknown") scores[tag.framework] += 5;
  }

  // JSX extension bonus
  const e = ext(parsed.filePath);
  if (e === ".tsx" || e === ".jsx") scores.react += 8;

  const top = (["react", "angular", "vue"] as Framework[]).reduce(
    (a, b) => (scores[a] >= scores[b] ? a : b),
    "unknown" as Framework,
  );

  const totalScore = scores.react + scores.angular + scores.vue;
  const confidence =
    totalScore > 0
      ? Math.min(100, Math.round((scores[top] / totalScore) * 100))
      : 0;

  return { primary: top, confidence };
}

function ext(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

function decoratorName(dec: ts.Decorator): string | null {
  const expr = dec.expression;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression))
    return expr.expression.text;
  return null;
}

function extractCalleeFromDetail(v: ParsedVariable): string | null {
  // detail may be "hook: useXxx" or the type annotation; try to extract call name
  if (!v.detail) return null;
  const m = v.detail.match(/^(?:hook:\s*)?([A-Za-z_$][A-Za-z0-9_$]*)/);
  return m ? m[1] : null;
}

function vueRole(callee: string): VueRole {
  if (
    callee === "ref" ||
    callee === "reactive" ||
    callee === "shallowRef" ||
    callee === "shallowReactive"
  ) {
    return "reactive-ref";
  }
  if (callee === "computed") return "computed";
  if (callee === "watch" || callee === "watchEffect") return "watch";
  if (/^on[A-Z]/.test(callee)) return "lifecycle-hook";
  if (callee === "defineComponent") return "component";
  return "composable";
}

function vueIcon(role: VueRole): string {
  switch (role) {
    case "component":
      return "symbol-class";
    case "composable":
      return "symbol-event";
    case "reactive-ref":
      return "symbol-variable";
    case "computed":
      return "symbol-property";
    case "watch":
      return "eye";
    case "lifecycle-hook":
      return "symbol-event";
    default:
      return "symbol-misc";
  }
}
