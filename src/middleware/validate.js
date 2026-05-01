'use strict';

/**
 * validate.js — Request validation middleware
 * Uses express-validator for input validation
 */

const { body, validationResult } = require('express-validator');

/**
 * validate — runs validation rules and returns 400 if any fail
 */
const validate = (rules) => async (req, res, next) => {
  if (!rules || rules.length === 0) return next();

  // Run all validation rules
  await Promise.all(rules.map(rule => rule.run(req)));

  const errors = validationResult(req);
  if (errors.isEmpty()) return next();

  return res.status(400).json({
    success: false,
    message: 'Validation failed',
    errors:  errors.array().map(e => ({ field: e.path, message: e.msg })),
  });
};

/**
 * schemas — validation rule sets for each route
 */
const schemas = {

  // POST /api/auth/login
  login: [
    body('email')
      .trim()
      .notEmpty().withMessage('Email is required')
      .isEmail().withMessage('Valid email required'),
    body('password')
      .notEmpty().withMessage('Password is required')
      .isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],

  // POST /api/auth/change-password
  changePassword: [
    body('currentPassword')
      .notEmpty().withMessage('Current password is required'),
    body('newPassword')
      .notEmpty().withMessage('New password is required')
      .isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
  ],

  // POST /api/employees
  createEmployee: [
    body('name')
      .trim()
      .notEmpty().withMessage('Employee name is required')
      .isLength({ max: 100 }).withMessage('Name too long'),
    body('phone')
      .optional()
      .trim()
      .matches(/^[6-9]\d{9}$/).withMessage('Valid 10-digit Indian mobile number required'),
    body('uan')
      .optional()
      .trim()
      .isLength({ min: 12, max: 12 }).withMessage('UAN must be exactly 12 digits')
      .isNumeric().withMessage('UAN must be numeric'),
    body('dateOfJoining')
      .optional()
      .isISO8601().withMessage('Date of joining must be a valid date (YYYY-MM-DD)'),
    body('dateOfBirth')
      .optional()
      .isISO8601().withMessage('Date of birth must be a valid date (YYYY-MM-DD)'),
  ],

  // POST /api/tenders
  createTender: [
    body('name')
      .trim()
      .notEmpty().withMessage('Tender name is required')
      .isLength({ max: 200 }).withMessage('Tender name too long'),
    body('clientId')
      .notEmpty().withMessage('Client is required'),
    body('startDate')
      .notEmpty().withMessage('Start date is required')
      .isISO8601().withMessage('Start date must be a valid date'),
    body('endDate')
      .notEmpty().withMessage('End date is required')
      .isISO8601().withMessage('End date must be a valid date'),
  ],

};

module.exports = { validate, schemas };
