// src/utils/asyncHandler.js
// Wraps async route handlers to catch errors without try/catch
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
