import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

// qoropick Sealer — 운영 서버와 분리된 정적 사이트(GitHub Pages 등). 참가자가 spin 을 뽑고 봉인하는 곳.
// 본 앱의 규칙 모듈(src/lib)을 그대로 공유한다: 봉인 형식이 한 벌이어야 서버의 봉투 검사와 어긋나지 않는다.
//
// 빌드된 Seal 페이지에는 CSP `connect-src 'none'` 이 박힌다: 이 페이지는 **어떤 네트워크 요청도 할 수 없다.**
// spin 을 어디로도 보낼 수 없다는 것을, 코드를 읽지 않고도 브라우저가 보장한다.
// (개발 서버는 HMR 웹소켓이 필요해 CSP 를 넣지 않는다.)

const commit = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "dev";
  }
})();

const CSP: Record<string, string> = {
  "index.html":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "check.html":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src https: http://localhost:*; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function csp(): Plugin {
  return {
    name: "qoropick-sealer-csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const file = ctx.filename.split("/").pop() ?? "";
        const policy = CSP[file];
        return policy ? html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`) : html;
      },
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
  define: {
    __SEALER_COMMIT__: JSON.stringify(commit),
  },
  server: { port: 5174 },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        check: fileURLToPath(new URL("./check.html", import.meta.url)),
      },
    },
  },
  plugins: [csp()],
});
