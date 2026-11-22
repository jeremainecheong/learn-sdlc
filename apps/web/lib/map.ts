/**
 * The project map, as the browser reads it.
 *
 * The builder itself lives in `@learnsdlc/shared`: the API builds the same map
 * from the same function, so `GET /projects/:slug/map` and this module can
 * never draw two different graphs. The app imports these names from here.
 */
export {
  buildProjectMap,
  fileReference,
  stateLabel,
  type MapEdge,
  type MapNode,
  type MapNodeKind,
  type ProjectMapData,
} from '@learnsdlc/shared';
