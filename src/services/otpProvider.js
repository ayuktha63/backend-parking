'use strict';

/**
 * OTP delivery.
 *
 * Two implementations behind one interface:
 *   console — writes the code to the log. Development only.
 *   msg91   — sends a WhatsApp template message.
 *
 * The provider is selected by config, so tests and local development never touch a
 * paid external service, and production cannot accidentally fall back to printing
 * codes (config validation rejects OTP_EXPOSE_IN_RESPONSE in production).
 */

const { config } = require('../config');
const { logger } = require('../utils/logger');
const { maskPhone } = require('../utils/logger');
const { serviceUnavailable } = require('../utils/errors');

/** @typedef {{ send(phone: string, code: string): Promise<{delivered: boolean, channel: string}> }} OtpProvider */

/** Development provider: logs the code instead of sending it. */
const consoleProvider = {
  async send(phone, code) {
    logger.warn(
      { phone: maskPhone(phone), code },
      'OTP delivered to the log (development provider). Never enable this in production.'
    );
    return { delivered: true, channel: 'console' };
  },
};

/** Used by automated tests: records calls, sends nothing. */
function createMemoryProvider() {
  const sent = [];
  return {
    sent,
    async send(phone, code) {
      sent.push({ phone, code, at: new Date() });
      return { delivered: true, channel: 'memory' };
    },
  };
}

/** MSG91 WhatsApp template delivery. */
const msg91Provider = {
  async send(phone, code) {
    const { authKey, templateName, namespace, integratedNumber, countryCode } =
      config.otp.msg91;

    if (!authKey || !namespace || !integratedNumber) {
      throw serviceUnavailable(
        'Verification is temporarily unavailable. Please try again shortly.'
      );
    }

    // Required lazily so a missing dependency cannot stop the process booting.
    // eslint-disable-next-line global-require
    const axios = require('axios');

    const payload = {
      integrated_number: integratedNumber,
      content_type: 'template',
      payload: {
        messaging_product: 'whatsapp',
        type: 'template',
        template: {
          name: templateName,
          language: { code: 'en', policy: 'deterministic' },
          namespace,
          to_and_components: [
            {
              to: [`${countryCode}${phone}`],
              components: { body_1: { type: 'text', value: code } },
            },
          ],
        },
      },
    };

    try {
      await axios.post(
        'https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/',
        payload,
        {
          headers: { 'Content-Type': 'application/json', authkey: authKey },
          timeout: 10_000,
        }
      );
      return { delivered: true, channel: 'whatsapp' };
    } catch (err) {
      // The provider's response may echo request content; log it at debug only and
      // never return it to the caller. The previous implementation returned the raw
      // MSG91 error body straight to the client.
      logger.error(
        { phone: maskPhone(phone), status: err?.response?.status },
        'OTP delivery failed'
      );
      logger.debug({ providerBody: err?.response?.data }, 'OTP provider response');
      throw serviceUnavailable('We could not send your code. Please try again.');
    }
  },
};

function getProvider() {
  switch (config.otp.provider) {
    case 'msg91':
      return msg91Provider;
    case 'memory':
      return createMemoryProvider();
    case 'console':
    default:
      return consoleProvider;
  }
}

module.exports = { getProvider, consoleProvider, msg91Provider, createMemoryProvider };
