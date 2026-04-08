// src/middleware/errorHandler.js
const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal Server Error';

  // Prisma errors
  if (err.code === 'P2002') {
    statusCode = 409;
    const field = err.meta?.target?.[0] || 'field';
    message = `A record with this ${field} already exists`;
  }
  if (err.code === 'P2025') {
    statusCode = 404;
    message = 'Record not found';
  }
  if (err.code === 'P2003') {
    statusCode = 400;
    message = 'Referenced record does not exist';
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid token';
  }
  if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Token expired, please login again';
  }

  logger.error(`${req.method} ${req.path} — ${statusCode}: ${message}`, {
    stack: err.stack,
    body: req.body,
    params: req.params,
    query: req.query,
    userId: req.user?.id,
  });

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack, errors: err.errors }),
  });
};

module.exports = errorHandler;
