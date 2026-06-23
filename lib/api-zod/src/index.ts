export * from "./generated/api";
export * from "./generated/types";

// Endpoints with both path and query params make orval emit a `<Op>Params` zod
// schema (path params) in ./generated/api and a same-named TS type (query params)
// in ./generated/types, which collide under the wildcard re-exports above.
// Explicitly re-export the zod schemas to resolve the ambiguity.
export { GetDepartmentParams, GetEmployeeParams, GetAgentParams } from "./generated/api";
