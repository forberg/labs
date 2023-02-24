import { existsSync, readFileSync } from "node:fs";
import { join, basename, parse } from "node:path";
import ResponseTiming from "fastify-metrics-js-response-timing";
import fp from "fastify-plugin";
import { html } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import EikClient from "@eik/node-client";
import { fastifyStatic } from "@fastify/static";
import { render as ssr } from "@lit-labs/ssr";
import Podlet from "@podium/podlet";
import fastifyPodletPlugin from "@podium/fastify-podlet";
import ProcessExceptionHandlers from "./process-exception-handlers.js";
import esbuild from "esbuild";
import { minifyHTMLLiteralsPlugin } from "esbuild-plugin-minify-html-literals";
import Metrics from "@metrics/client";
import { SemVer } from "semver";

/**
 * TODO:
 * - remove eik, make paths configurable
 * - compression middleware
 * - localisation
 */

const renderModes = {
  SSR_ONLY: "ssr-only",
  CSR_ONLY: "csr-only",
  HYDRATE: "hydrate",
};

const plugin = async function fastifyPodletServerPlugin(fastify, { config }) {
  const NAME = config.get("app.name");
  const VERSION = config.get("podlet.version");
  const PATHNAME = config.get("podlet.pathname");
  const MANIFEST = config.get("podlet.manifest");
  const CONTENT = config.get("podlet.content");
  const FALLBACK = config.get("podlet.fallback");
  const DEVELOPMENT = config.get("app.development");
  const COMPONENT = config.get("app.component");
  const PROCESS_EXCEPTION_HANDLERS = config.get("app.processExceptionHandlers");
  const RENDER_MODE = config.get("app.mode");
  const GRACE = config.get("app.grace");
  const METRICS_ENABLED = config.get("metrics.enabled");
  const TIMING_METRICS = config.get("metrics.timing.enabled");
  const TIME_ALL_ROUTES = config.get("metrics.timing.timeAllRoutes");
  const GROUP_STATUS_CODES = config.get("metrics.timing.groupStatusCodes");
  const PACKAGE_JSON = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), { encoding: "utf8" }));
  const PODIUM_VERSION = new SemVer(PACKAGE_JSON.dependencies["@podium/podlet"].replace("^", "").replace("~", ""));

  const metricStreams = [];

  let dsdPolyfill = "";
  try {
    dsdPolyfill = readFileSync(new URL("./dsd-polyfill.js", import.meta.url), { encoding: "utf8" });
  } catch (err) {}

  const podlet = new Podlet({
    name: NAME,
    version: VERSION,
    pathname: PATHNAME,
    manifest: MANIFEST,
    content: CONTENT,
    fallback: FALLBACK,
    development: DEVELOPMENT,
    logger: fastify.log,
  });

  fastify.decorate("podlet", podlet);
  fastify.decorate("proxy", podlet.proxy.bind(podlet));

  const eik = new EikClient({
    development: DEVELOPMENT,
    base: "/static",
  });

  fastify.decorate("eik", eik);

  // await fastify.register(compress, { global: true });

  if (DEVELOPMENT) {
    fastify.register(fastifyStatic, {
      root: join(process.cwd(), "dist"),
      prefix: "/static/",
    });
  }

  if (PROCESS_EXCEPTION_HANDLERS) {
    const procExp = new ProcessExceptionHandlers(fastify.log);
    procExp.closeOnExit(fastify, { grace: GRACE });
    metricStreams.push(procExp.metrics);
  }

  // @ts-ignore
  fastify.register(fastifyPodletPlugin, podlet);
  // @ts-ignore
  metricStreams.push(podlet.metrics);

  // @ts-ignore
  const gauge = podlet.metrics.gauge({
    name: "active_podlet",
    description: "Indicates if a podlet is mounted and active",
    // TODO: read this value from podium package.json
    labels: { podium_version: PODIUM_VERSION.major, podlet_name: NAME },
  });
  setImmediate(() => gauge.set(1));

  // manifest route
  // @ts-ignore
  fastify.get(join("/", NAME || "", podlet.manifest()), async (req, reply) => {
    // enable timing metrics for this route
    reply.context.config.timing = true;

    return JSON.stringify(podlet);
  });

  if (TIMING_METRICS) {
    const responseTiming = new ResponseTiming({ timeAllRoutes: TIME_ALL_ROUTES, groupStatusCodes: GROUP_STATUS_CODES });
    fastify.register(responseTiming.plugin());
    metricStreams.push(responseTiming.metrics);
  }

  if (!COMPONENT) return;

  /**
   * setContentState function
   *
   * Use this function to pass values to both server side and client side components.
   * This function will passed the Fastify request object as a first param and the Podium context as a second.
   * Values set with this function will be available in the render hook of the content.js content custom element component via
   * `this.getInitialState();`
   * @example
   *  ```
   *  // in server.js
   *  export default async function server(app) {
   *    app.setFallbackState(async (req, context) => {
   *      // fetch database values or other api sources here and return below
   *      return {
   *        val1: "foo",
   *        val2: "bar",
   *      };
   *    });
   *  }
   *
   *  // in content.js
   *  class Content extends NmpElement {
   *    render() {
   *      // available on both server and client side.
   *      const { val1, val2 } = this.getInitialState();
   *      return html`<div>${val1}${val2}</div>`
   *    }
   *  }
   * ```
   * @param {import('fastify').FastifyRequest} req
   * @param {any} context
   * @returns {Promise<{ [key: string]: any; [key: number]: any; } | null>}
   */
  let setContentState = async (req, context) => ({});

  fastify.decorate(
    "setContentState",
    /**
     * @param {(req: import('fastify').FastifyRequest, context: any) => Promise<{ [key: string]: any; [key: number]: any; } | null>} stateFunction
     */
    (stateFunction) => {
      setContentState = stateFunction;
    }
  );

  /**
   * setFallbackState function
   *
   * Use this function to pass values to both server side and client side components.
   * Fallbacks are cached and therefore cannot gain access to the request object or the Podium context.
   * Values set with this function will be available in the render hook of the fallback.js fallback custom element component via
   * `this.getInitialState();`
   * @example
   *  ```
   *  // in server.js
   *  export default async function server(app) {
   *    app.setFallbackState(async () => {
   *      return {
   *        val1: "foo",
   *        val2: "bar",
   *      };
   *    });
   *  }
   *
   *  // in fallback.js
   *  class Fallback extends NmpElement {
   *    render() {
   *      // available on both server and client side.
   *      const { val1, val2 } = this.getInitialState();
   *      return html`<div>${val1}${val2}</div>`
   *    }
   *  }
   * ```
   * @param {import('fastify').FastifyRequest} req
   * @param {any} context
   * @returns {Promise<{ [key: string]: any; [key: number]: any; } | null>}
   */
  let setFallbackState = async (req, context) => ({});
  fastify.decorate(
    "setFallbackState",
    /**
     * @param {(req: import('fastify').FastifyRequest, context: any) => Promise<{ [key: string]: any; [key: number]: any; } | null>} stateFunction
     */
    (stateFunction) => {
      setFallbackState = stateFunction;
    }
  );

  /**
   * Imports a custom element by pathname, bundles it and registers it in the server side custom element
   * registry.
   * In production mode, this happens 1x for each unique filepath after which this function will noop
   * In development mode, every call to this function will yield a fresh version of the custom element being re-registered
   * to the custom element registry.
   * @param {string} filepath
   */
  const importComponentForSSR = async (filepath) => {
    const type = parse(filepath).name;
    const outdir = join(process.cwd(), "dist", "server");

    // if already defined from a previous request, delete from registry
    if (customElements.get(`${NAME}-${type}`)) {
      // if in production mode and the component has already been defined,
      // no more work is needed, so we bail early
      if (!DEVELOPMENT) return;
      // @ts-ignore
      customElements.__definitions.delete(`${NAME}-${type}`);
    }

    // import cache breaking filename using date string
    const ssrfile = join(outdir, `${basename(filepath)}?s=${Date.now()}`);
    if (existsSync(filepath)) {
      try {
        await esbuild.build({
          entryPoints: [filepath],
          bundle: true,
          format: "esm",
          outdir,
          minify: true,
          plugins: [minifyHTMLLiteralsPlugin()],
          legalComments: `none`,
          platform: "node",
          sourcemap: true,
        });
        // import fresh copy of the custom element
        const Element = (await import(ssrfile)).default;

        // define newly imported custom element in the registry
        customElements.define(`${NAME}-${type}`, Element);
      } catch (err) {
        fastify.log.error(err);
      }
    }
  };

  fastify.decorateReply("hydrate", async function hydrate(template, file) {
    this.type("text/html");
    await importComponentForSSR(join(process.cwd(), file));

    const markup = Array.from(ssr(html` ${unsafeHTML(template)} `)).join("");
    // @ts-ignore
    this.podiumSend(
      `${markup}<script>${dsdPolyfill}</script><script type="module" src="${
        eik.file(`/client/${file}`).value
      }"></script>`
    );
  });

  fastify.decorateReply("ssrOnly", async function ssrOnly(template, file) {
    this.type("text/html");
    await importComponentForSSR(join(process.cwd(), file));
    const markup = Array.from(ssr(html` ${unsafeHTML(template)} `)).join("");
    // @ts-ignore
    this.podiumSend(`${markup}<script>${dsdPolyfill}</script>`);
  });

  fastify.decorateReply("csrOnly", function csrOnly(template, file) {
    this.type("text/html");
    // @ts-ignore
    this.podiumSend(`${template}<script type="module" src="${eik.file(`/client/${file}`).value}"></script>`);
  });

  if (existsSync(join(process.cwd(), "content.js"))) {
    // if in development mode redirect root to content route
    if (DEVELOPMENT) {
      fastify.get("/", (request, reply) => {
        reply.redirect(join("/", NAME || "", podlet.content()));
      });
    }

    // register user defined validation schema for route if provided
    // looks for a file named schemas/content.js and if present, imports
    // and provides to route.
    const contentOptions = {};
    if (existsSync(join(process.cwd(), "schemas/content.js"))) {
      contentOptions.schema = (await import(join(process.cwd(), "schemas/content.js"))).default;
    }

    // builds content route path out of root + app name + the content path value in the podlet manifest
    // by default this will be / + folder name + / eg. /my-podlet/
    const contentRoutePath = join("/", NAME || "", podlet.content());
    // content route
    fastify.get(contentRoutePath, contentOptions, async (req, reply) => {
      // enable timing metrics for this route
      reply.context.config.timing = true;

      const initialState = JSON.stringify(
        // @ts-ignore
        (await setContentState(req, reply.app.podium.context)) || ""
      );
      const template = `<${NAME}-content initial-state='${initialState}'></${NAME}-content>`;

      switch (RENDER_MODE) {
        case renderModes.SSR_ONLY:
          // @ts-ignore
          reply.ssrOnly(template, "content.js");
          break;
        case renderModes.CSR_ONLY:
          // @ts-ignore
          reply.csrOnly(template, "content.js");
          break;
        case renderModes.HYDRATE:
          // @ts-ignore
          await reply.hydrate(template, "content.js");
          break;
      }
    });
  } else {
    // if in development mode and no content route is defined, redirect root to manifest route
    if (DEVELOPMENT) {
      fastify.get("/", (request, reply) => {
        reply.redirect(join("/", NAME || "", podlet.manifest()));
      });
    }
  }

  if (existsSync(join(process.cwd(), "fallback.js"))) {
    // register user defined validation schema for route if provided
    // looks for a file named schemas/fallback.js and if present, imports
    // and provides to route.
    const fallbackOptions = {};
    if (existsSync(join(process.cwd(), "schemas/fallback.js"))) {
      fallbackOptions.schema = (await import(join(process.cwd(), "schemas/fallback.js"))).default;
    }

    // builds fallback route path out of root + app name + the fallback path value in the podlet manifest
    // by default this will be / + folder name + /fallback eg. /my-podlet/fallback
    const fallbackRoutePath = join("/", NAME || "", podlet.fallback());
    // fallback route
    fastify.get(fallbackRoutePath, fallbackOptions, async (req, reply) => {
      // enable timing metrics for this route
      reply.context.config.timing = true;

      const initialState = JSON.stringify(
        // @ts-ignore
        (await setFallbackState(req, reply.app.podium.context)) || ""
      );
      const template = `<${NAME}-fallback initial-state='${initialState}'></${NAME}-fallback>`;
      switch (RENDER_MODE) {
        case renderModes.SSR_ONLY:
          // @ts-ignore
          reply.ssrOnly(template, "fallback.js");
          break;
        case renderModes.CSR_ONLY:
          // @ts-ignore
          reply.csrOnly(template, "fallback.js");
          break;
        case renderModes.HYDRATE:
          // @ts-ignore
          reply.hydrate(template, "fallback.js");
          break;
      }
    });
  }

  if (METRICS_ENABLED) {
    const metrics = new Metrics();
    for (const stream of metricStreams) {
      stream.on("error", (err) => {
        fastify.log.error(err);
      });
      stream.pipe(metrics);
    }
    fastify.decorate("metrics", metrics);
  }
};

export default fp(plugin);
