three.js 0.186.1 (MIT, see LICENSE), from the npm package `three`:
build/three.module.js, build/three.core.js, examples/jsm/controls/OrbitControls.js
and TransformControls.js.

One change: the two controls import `./three.module.js` instead of the bare name
`three`. A bare name needs an import map, and an inline import map is blocked by
the page's Content-Security-Policy (script-src 'self').
