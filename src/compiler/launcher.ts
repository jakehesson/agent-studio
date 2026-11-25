import type { IdeTarget } from "../schema/team.js";

const SAFE_TOKEN_RE = /^[a-zA-Z0-9_-]+$/;
const FORBIDDEN_BODY_RE = /["$`%\\\r\n]/;

function buildLauncherBody(argsExpr: string, onMissing: "fail-open" | "mcp-error"): string {
  const fallback =
    onMissing === "fail-open"
      ? "process.exit(0);"
      : "console.error('agent-studio CLI not found. Install the Agent Studio VS Code/Antigravity extension or run: npm i -g agent-studio');process.exit(1);";

  const body = [
    "const f=require('node:fs'),p=require('node:path'),o=require('node:os'),c=require('node:child_process');",
    `const a=${argsExpr};`,
    "const h=(process.env.AGENT_STUDIO_HOME||'').trim()||p.join(o.homedir(),'.agent-studio');",
    "const s=p.join(h,'bin','studio-cli.mjs');",
    "if(f.existsSync(s)){const r=c.spawnSync(process.execPath,[s,...a],{stdio:'inherit'});if(!r.error)process.exit(r.status===null?1:r.status);}",
    "const w=process.platform==='win32';",
    "const q=String.fromCharCode(34);",
    "const run=(x)=>{const l=x.toLowerCase();const r=w&&(l.endsWith('.cmd')||l.endsWith('.bat'))?c.spawnSync(process.env.ComSpec||p.join(process.env.SystemRoot||p.join('C:','Windows'),'System32','cmd.exe'),['/d','/s','/c',q+q+x+q+' '+a.join(' ')+q],{stdio:'inherit',windowsVerbatimArguments:true}):c.spawnSync(x,a,{stdio:'inherit'});if(!r.error)process.exit(r.status===null?1:r.status);};",
    "const lb=p.join(process.cwd(),'node_modules','.bin',w?'agent-studio.cmd':'agent-studio');",
    "if(f.existsSync(lb))run(lb);",
    "const ns=w?['agent-studio.cmd','agent-studio.exe']:['agent-studio'];",
    "for(const d of (process.env.PATH||'').split(p.delimiter)){const t=d.trim().replaceAll(q,'');if(!t)continue;for(const n of ns){const e=p.join(t,n);try{f.accessSync(e,w?f.constants.F_OK:f.constants.X_OK);if(f.statSync(e).isFile())run(e);}catch{}}}",
    fallback,
  ].join("");

  if (FORBIDDEN_BODY_RE.test(body)) {
    throw new Error("Portable launcher body contains shell-unsafe characters.");
  }
  return body;
}

export function buildPortableHookCommand(
  ide: IdeTarget,
  eventName: string,
): string {
  if (!SAFE_TOKEN_RE.test(ide)) {
    throw new Error(`Invalid IDE target for hook command: ${ide}`);
  }
  if (!SAFE_TOKEN_RE.test(eventName)) {
    throw new Error(`Invalid event name for hook command: ${eventName}`);
  }
  // Keep 'agent-studio hook-emit --ide <ide> --event <ev>' verbatim so HOOK_TAG_NEEDLE
  // and doctor/compiler checks continue to identify managed hook entries.
  const argsExpr = `'agent-studio hook-emit --ide ${ide} --event ${eventName}'.split(' ').slice(1)`;
  const body = buildLauncherBody(argsExpr, "fail-open");
  return `node -e "${body}"`;
}

export function buildPortableMcpSpec(): {
  command: "node";
  args: ["-e", string];
} {
  const body = buildLauncherBody("['mcp']", "mcp-error");
  return {
    command: "node",
    args: ["-e", body],
  };
}
