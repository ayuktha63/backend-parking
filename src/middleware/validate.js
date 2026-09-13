'use strict';

/**
 * Request validation.
 *
 * Every route declares a zod schema for the parts of the request it reads. The
 * validated, coerced result replaces req.body/query/params, so controllers never
 * see raw input.
 *
 * The previous implementation validated by hand and inconsistently: `vehicle_type`
 * was checked against an enum in the slots endpoint but not in the booking handler,
 * so any string was accepted and anything other than 'car' silently decremented bike
 * availability. `entry_time` was never validated at all — `new Date("garbage")`
 * produced Invalid Date and was inserted.
 */

const { unprocessable } = require('../utils/errors');

/** Turns a ZodError into a flat, client-safe field map. */
function formatZodError(error) {
  const fieldErrors = {};
  for (const issue of error.issues || []) {
    const path = issue.path.join('.') || '_';
    if (!fieldErrors[path]) fieldErrors[path] = [];
    fieldErrors[path].push(issue.message);
  }
  return fieldErrors;
}

/**
 * @param {{body?: import('zod').ZodTypeAny, query?: import('zod').ZodTypeAny, params?: import('zod').ZodTypeAny}} schemas
 */
function validate(schemas = {}) {
  return function validator(req, res, next) {
    const problems = {};

    for (const part of ['params', 'query', 'body']) {
      const schema = schemas[part];
      if (!schema) continue;

      const result = schema.safeParse(req[part]);
      if (!result.success) {
        const formatted = formatZodError(result.error);
        for (const [field, messages] of Object.entries(formatted)) {
          problems[`${part}.${field}`] = messages;
        }
        continue;
      }

      // Express 5 makes req.query a getter; assigning to a private field and
      // exposing it under a stable name avoids fighting the framework.
      if (part === 'query') {
        req.validatedQuery = result.data;
      } else {
        req[part] = result.data;
      }
    }

    if (Object.keys(problems).length > 0) {
      return next(
        unprocessable('Some fields need attention', { fields: problems })
      );
    }

    // Keep a single accessor so controllers do not care which Express version is used.
    if (!schemas.query) req.validatedQuery = req.query;

    return next();
  };
}

module.exports = { validate, formatZodError };
