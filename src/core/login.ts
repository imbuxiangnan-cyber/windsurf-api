/**
 * Windsurf authentication — REST API login.
 */

import https from 'https';
import { log } from '../config.js';

const DEVIN_LOGIN_URL = 'https://windsurf.com/_devin-auth/password/login';
const WINDSURF_POSTAUTH_URL = 'https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth';

function postJson(url: string, body: object): Promise<{ status: number; data: any }> {
  return new Promise((resolve) => {
    const postData = JSON.stringify(body);
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://windsurf.com/',
        'Origin': 'https://windsurf.com',
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode || 0, data: null });
        }
      });
    });
    req.on('error', () => resolve({ status: 0, data: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: null }); });
    req.write(postData);
    req.end();
  });
}

export interface LoginResult {
  sessionToken: string;
  auth1Token: string;
  accountId: string;
}

/**
 * Login with email+password → get session token (apiKey for channels).
 */
export async function windsurfLogin(email: string, password: string): Promise<LoginResult> {
  log.info(`Logging in as ${email}...`);

  const loginRes = await postJson(DEVIN_LOGIN_URL, { email, password });
  if (loginRes.status !== 200 || !loginRes.data?.token) {
    throw new Error(`Login failed: ${loginRes.status} ${JSON.stringify(loginRes.data)}`);
  }
  const auth1Token: string = loginRes.data.token;

  return exchangeForSession(auth1Token);
}

/**
 * Login with OTT (one-time token from windsurf.com).
 */
export async function windsurfOttLogin(ott: string): Promise<LoginResult> {
  log.info('Exchanging OTT for session token...');

  // Try as auth1_token first
  const res1 = await postJson(WINDSURF_POSTAUTH_URL, { auth1_token: ott });
  if (res1.status === 200 && res1.data?.sessionToken) {
    log.info('OTT login successful (via auth1_token)');
    return {
      sessionToken: res1.data.sessionToken,
      auth1Token: res1.data.auth1Token || ott,
      accountId: res1.data.accountId || '',
    };
  }

  // Try as ott_token
  const res2 = await postJson(WINDSURF_POSTAUTH_URL, { ott_token: ott });
  if (res2.status === 200 && res2.data?.sessionToken) {
    log.info('OTT login successful (via ott_token)');
    return {
      sessionToken: res2.data.sessionToken,
      auth1Token: res2.data.auth1Token || ott,
      accountId: res2.data.accountId || '',
    };
  }

  // Try as token
  const res3 = await postJson(WINDSURF_POSTAUTH_URL, { token: ott });
  if (res3.status === 200 && res3.data?.sessionToken) {
    log.info('OTT login successful (via token)');
    return {
      sessionToken: res3.data.sessionToken,
      auth1Token: res3.data.auth1Token || ott,
      accountId: res3.data.accountId || '',
    };
  }

  throw new Error(`OTT exchange failed. Responses: ${res1.status}, ${res2.status}, ${res3.status}`);
}

async function exchangeForSession(auth1Token: string): Promise<LoginResult> {
  const postAuthRes = await postJson(WINDSURF_POSTAUTH_URL, { auth1_token: auth1Token });
  if (postAuthRes.status !== 200 || !postAuthRes.data?.sessionToken) {
    throw new Error(`PostAuth failed: ${postAuthRes.status} ${JSON.stringify(postAuthRes.data)}`);
  }

  log.info('Login successful');
  return {
    sessionToken: postAuthRes.data.sessionToken,
    auth1Token: postAuthRes.data.auth1Token,
    accountId: postAuthRes.data.accountId,
  };
}
