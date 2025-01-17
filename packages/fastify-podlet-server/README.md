# Fastify Podlet Server [Experimental]

This package can be used to bootstrap an opinionated Podium podlet server that provides:

- Shadow dom isolation via Lit custom elements
- SSR + hydrate, CSR or SSR only
- Built in localisation support
- Metrics collection
- Automatically generated content, fallback and manifest routes
- A Dev mode with watch/live reload
- A pluggable build pipeline based on Esbuild
- Easy extensible configuration system based on the convict module.

## Getting started

Install the following 2 packages:

```
npm install @podium/experimental-fastify-podlet-server @podium/experimental-lit-base-class
```

Create a file called `content.js` in your project root that provides a Lit custom element as the default export.
While any Lit Element component will work the provided base class provides enhanced functionality which will be used
later in this guide.

```js
import { html, css } from "lit";
import { PodiumPodletElement } from "@podium/experimental-lit-base-class";

export default class Content extends PodiumPodletElement {
  static styles = css`
    .demo {
      color: hotpink;
    }
  `;

  render() {
    return html`<section class=".demo">This is a demo</section>`;
  }
}
```

Start the server in dev mode

```
npx podlet-dev
```

And visit `http://localhost:8080` in your browser.

You should see the text "This is a demo" in hot pink. This was both rendered server side and also hydrated client side out of the box.

## The App Name

Podlet's must have a name value. This module restricts names to a-z and the - character as in `my-podlet`.
This name value is used for a number of things and by default is read from the package.json name field.
If you don't create a valid name, the app with throw an error. You can configure this name value either by changing the package.json name field
or by using config. (see the config section below).
By default, the podlet's routes are mounted under a pathname specified by app name.

Example

```
# if name is my-podlet
# The manifest route will be
http://localhost:8080/my-podlet/manifest.json
# The content route will be
http://localhost:8080/my-podlet
# and the fallback route will be
http://localhost:8080/my-podlet/fallback
```

## Routes

Podium podlet's typically require that you define 3 main routes, a content, a fallback and a manifest route.
Additional API routes can also be defined as needed.

### Content

The content route can be defined by adding a file called `content.js` and providing a LitElement class as default export. (See the example above).
When you start the app, this file will be detected and setup for SSR and hydration at the path `http://localhost:8080/<podlet-name-value>`.

### Fallback

The fallback route can be defined by adding a file called `fallback.js` and providing a LitElement class as default export in the same way as for content.js.
When you start the app, this file will be detected and setup for SSR and hydration at the path `http://localhost:8080/<podlet-name-value>/fallback`.

### Manifest

A manifest route is automatically setup at `http://localhost:8080/<podlet-name-value>/manifest.json`

### Additional API Routes

See the section below on server customisation for how you can hook in to define additional routes.

## App Modes

The podlet server can be configured to run under one of several modes to cater for different use cases.
These modes are `hydrate`, `ssr-only` and `csr-only`.

This can be configured using the config setting `app.mode`. (see the config section below)

### Server Side Rendered (hydrate)

When `app.mode` is set to `hydrate`, the content and fallback routes will be server rendered and then client side hydrated afterward.
No additional setup is required but see guidelines for writing SSR custom elements on the Lit docs site. [https://lit.dev/docs/ssr/authoring/](https://lit.dev/docs/ssr/authoring/).

### Server Side Rendered (ssr-only)

When `app.mode` is set to `ssr-only`, the content and fallback routes will be server rendered but will not be hydrated on the client side afterward.
This is good if you want to use components from a shared library or design system but don't actually need interactivity on the client side.
It is recommended you use this option whenever possible since it will save many KBs of JavaScript being sent to the users browser.
No additional setup is required but see guidelines for writing SSR custom elements on the Lit docs site. [https://lit.dev/docs/ssr/authoring/](https://lit.dev/docs/ssr/authoring/).

### Client Side Rendered (csr-only)

When `app.mode` is set to `csr-only`, the content and fallback routes will not be rendered on the server but will be "upgraded" on the client side.
This module will render out a tag for the element and the code in content.js and fallback.js will be used client side to define the tag.
This is a good option if your podlet provides functionality that is not initially seen when a page is loaded such as a modal dialog etc.

## Server Customisation

By default, the app will run without any server configuration but in many cases you will want access to the server in order to plug in functionality,
define api routes or serialize data from the backend and provide it to the client. This can be done by creating a Fastify plugin in a `server.js` file.

The signature for the plugin is as follows

```js
// server.js
export function server(fastify, { config, podlet }) {}
```

Notice that an instance of the fastify app, a config object and an instance of the Podium podlet class are all passed into the plugin.
See [the Fastify plugin docs](https://www.fastify.io/docs/latest/Reference/Plugins/) for more information on defining Fastify plugins, below for more information on the config object and [the Podium podlet docs](https://podium-lib.io/docs/podlet/getting_started) for more information on podlets.

### Sharing Values Between Server and Client

Within the server plugin, you have access to a couple functions that can be used to share data from the server with the client.

These are:

- fastify.setContentState(obj)
- fastify.setFallbackState(obj)

Any object passed to these functions will be serialized on the server side and deserialized for use on the client side.
The same data will be used server side for SSR.

```js
// server.js
export function server(fastify, { config, podlet }) {
  fastify.setContentState(() => ({
    key: "value",
  }));
}
```

```js
// content.js
export default class Content extends PodiumPodletElement {
  render() {
    return html`<section>${this.initialState.key}</section>`;
  }
}
```

As the names imply, `setContentState` only applies to the content route and `setFallbackState` only applies to the fallback route.

### Defining API routes

You can define additional API routes for use in the client by using the fastify object

```js
// server.js
export function server(fastify, { config, podlet }) {
  // http://localhost:8080/<my-podlet-name>/api
  const pathname = join(config.get("app.name"), "api");
  fastify.get(pathname, async (req, reply) => {
    return { key: "value" };
  });
}
```

For the client to be able to locate the api route when mounted in any layout you can use Podium context values to build paths and send them to the client
using `.setContentState`.

```js
// server.js
export function server(fastify, { config, podlet }) {
  fastify.setContentState((request, context) => ({
    api: new URL(`${context.publicPathname}/api`, context.mountOrigin).href,
  }));
}
```

Then on the client side, you can use `initialState` to get the api url and start using it to make requests

```js
// content.js
export default class Content extends PodiumPodletElement {
    static properties = {
        data: { state: true },
    }
    connectedCallback() {
        super.connectedCallback();
        const result = await fetch(this.initialState.api);
        this.data = await result.json();
    }
}
```

Depending on your setup, you may need to use Podium proxying to give client side code access to podlet api routes.
This can be done in server.js using the podlet object like so:

```js
// server.js
export function server(fastify, { config, podlet }) {
  // http://localhost:8080/<my-podlet-name>/api
  const target = join(config.get("app.name"), "api");
  fastify.get(podlet.proxy({ target, name: "api" }), async (req, reply) => {
    return { key: "value" };
  });
}
```

See the [Podium proxy docs](https://podium-lib.io/docs/podlet/proxying) for more information

### Other uses for server.js

There are a plethora of Fastify plugins which can be plugged into the server via server.js

```js
// server.js
export function server(fastify, { config, podlet }) {
  fastify.register(pluginName, options);
}
```

## Configuration

The app comes with a built in configuration system based on [Convict](https://www.npmjs.com/package/convict).
Sensible defaults are provided but almost everything can be overridden or extended.

Configuration lives in a folder which must be named `config`. In this folder you can:

- Globally override configuration values in a `config/common.json` file.
- Override configuration for specific domains and environments in folders named using the pattern `config/domains/<domain name>/<env>.config.json`.
- Add additional config values for use throughout your app via a `schema` defined in `config/schema.js`

See the subsections below for additional information.

### Common Settings

When you need to override specific configuration settings regardless of context (whether that be domain or environment),
you can create a file called `config/common.json` and overide values by key. (See the list of config keys below for more)

For example, if you wanted to override the app name you would do that like so:

```json5
// config/common.json
{
  app: {
    name: "my-podlet",
  },
}
```

### Domain/Environment Specific Settings

2 environment variables can be set which will be used to determine the domain and the environment. These are DOMAIN (defaults to "localhost") and ENV (defaults to "local")
You are encouraged to set these values differently for each relevant environment that your app will run in. For example, if you have a single domain `www.finn.no`, a staging environment
and a production environment, then you would set DOMAIN=`www.finn.no` or `localhost` and ENV to either ENV=`local` or `staging` or `production` or perhaps even `test` if needed.
You will then be able to override config for any combination of these domains and environments by creating folders with json config files in them.

For example:

```
/config
    /domains
        /localhost
            /local.config.json
            /staging.config.json
            /test.config.json
            /production.config.json
        /www.finn.no
            /local.config.json
            /staging.config.json
            /test.config.json
            /production.config.json
```

Only create those files you need, you might not need any and in any case it probably doesn't make much sense to create some, /config/domains/localhost/production.config.json for example.

### Schemas

Extending the built in configuration values is possible via a schema file which, if defined, should be defined at `config/schema.js`
This file should follow the guidelines set out in [convict](https://www.npmjs.com/package/convict)

Example

```js
export default {
  db: {
    host: {
      doc: "Database host name/IP",
      format: "*",
      default: "server1.dev.test",
    },
    name: {
      doc: "Database name",
      format: String,
      default: "users",
    },
  },
};
```

Default values can be set and specific values can be assigned to environment variables if needed.
Any values defined in this file, can be overridden for specific domains and environments as described above in the section of domains and environments.

### List of built in config keys

#### App Config

| Key                            | Default                                         | ENV         | Possible Values                                    |
| ------------------------------ | ----------------------------------------------- | ----------- | -------------------------------------------------- |
| `app.name`                     | package.json name value                         | APP_NAME    |                                                    |
| `app.env`                      | local                                           | ENV         |                                                    |
| `app.domain`                   | localhost                                       | DOMAIN      |                                                    |
| `app.port`                     | 8080                                            | PORT        |                                                    |
| `app.logLevel`                 | INFO                                            | LOG_LEVEL   | "TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL" |
| `app.locale`                   | en-US                                           | LOCALE      |                                                    |
| `app.development`              | true when NODE_ENV=development, false otherwise | DEVELOPMENT | true/false                                         |
| `app.component`                | true                                            |             |                                                    |
| `app.mode`                     | hydrate                                         |             | hydrate, ssr-only, csr-only                        |
| `app.grace`                    | 0                                               |             |                                                    |
| `app.processExceptionHandlers` | true                                            |             | true/false                                         |
| `app.compression`              | true                                            |             | true/false                                         |

#### Podlet Config

| Key               | Default          | ENV     | Possible Values |
| ----------------- | ---------------- | ------- | --------------- |
| `podlet.pathname` | "/"              |         |                 |
| `podlet.version`  | ${Date.now()}    | VERSION |                 |
| `podlet.manifest` | "/manifest.json" |         |                 |
| `podlet.content`  | "/"              |         |                 |
| `podlet.fallback` | "/fallback"      |         |                 |

### Metrics Config

| Key                               | Default | ENV | Possible Values |
| --------------------------------- | ------- | --- | --------------- |
| `metrics.timing.timeAllRoutes`    | false   |     | true/false      |
| `metrics.timing.groupStatusCodes` | true    |     | true/false      |
| `metrics.timing.enabled`          | true    |     | true/false      |
| `metrics.enabled`                 | true    |     | true/false      |

### Assets Config

| Key                  | Default   | ENV | Possible Values |
| -------------------- | --------- | --- | --------------- |
| `assets.base`        | "/static" |     |                 |
| `assets.development` | false     |     | true/false      |

## Localisation

The app supports localisation out of the box. To start using it, you need to do the following 3 things:

1. Define locale json files in a `locale` folder

```json5
// locale/no.json
{
    "how_much_money": "Hvor mye penger har du i boden, egentlig?"
}
```

2. Use the `t()` function in your content and fallback routes.

```js
// content.js
export default class Content extends PodiumPodletElement {
    render() {
        return html`<section>${this.t("how_much_money")}</section>`;
    }
}
```

3. Set the correct locale setting, either in config or via the LOCALE environment variable

```
LOCALE=no podlet dev
```

Under the hood, lit-translate is used. [See the docs](https://www.npmjs.com/package/lit-translate?activeTab=readme) for more information

## Customising The Build Pipeline [Advanced]

Under the hood app builds and dev are provided by Esbuild. 
It's possible to hook into this build by creating a `build.js` file and defining an Esbuild plugin or plugins.

```js
// Exporting this function will get picked up and plugged into the build
// Must export a default export of a function and return an array of 1 or more Esbuild plugins
// app config is provided to the function
export default ({ config }) => [
  {
    // plugin name, snake case
    name: "esbuild-my-plugin",
    // setup function gets passed a build object which has various lifecycle hooks
    setup(build) {
      // must provide a filter regex to determine which files in the build will be handled
      build.onLoad({ filter: /(content|fallback)\.(ts|js)$/ }, async (args) => {
        
      });
    },
  },
];
```

See [the Esbuild docs](https://esbuild.github.io/plugins/) for more information.

## Metrics

Under the hood, various metrics are gathered and provided for consumption in server.js if desired.
[@metrics](https://www.npmjs.com/package/@metrics/client) is used to pipe metrics streams together.

```js
// server.js
export function server(fastify, { config, podlet }) {
  // fastify.metrics is a stream that can be piped into a consumer
}
```

## Typescript

Typescript is supported out of the box, just create content.ts and fallback.ts instead of their js counterparts.
Esbuild is used to provide this support and as such types are not checked, just stripped out.
Run tsc on the side to check types as part of your build.