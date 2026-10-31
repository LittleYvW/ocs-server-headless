/** Classify internal errors without copying form values, URLs, tokens or Playwright call logs. */
export function automationDiagnostic(value: unknown): { code: string; message: string } {
	const text = value instanceof Error ? `${value.name} ${value.message}` : typeof value === 'string' ? value : '';
	if (/OCR_TIMEOUT/.test(text)) return { code: 'OCR_TIMEOUT', message: 'OCR service timed out' };
	if (/OCR_(?:SERVICE_FAILED|INVALID_RESPONSE|RESPONSE_TOO_LARGE)/.test(text))
		return { code: 'OCR_SERVICE_FAILED', message: 'OCR service failed or returned an invalid result' };
	if (/OCR_UNAVAILABLE|验证码识别服务/.test(text))
		return { code: 'OCR_UNAVAILABLE', message: 'A configured OCR service is required for this login' };
	if (/timeout|timed out|超时/i.test(text))
		return { code: 'AUTOMATION_TIMEOUT', message: 'Automation exceeded its time limit' };
	if (/密码错误|账号错误|账户错误|登录失败|incorrect password|invalid credentials/i.test(text))
		return { code: 'LOGIN_REJECTED', message: 'The platform rejected the login' };
	if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_INTERNET_DISCONNECTED|navigation failed/i.test(text))
		return { code: 'PAGE_UNAVAILABLE', message: 'The platform page could not be reached' };
	return { code: 'AUTOMATION_FAILED', message: 'Automation did not complete successfully' };
}
