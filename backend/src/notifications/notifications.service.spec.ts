import { NotificationsService } from './notifications.service';

const sendMail = jest.fn().mockResolvedValue({});
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail })),
}));

describe('NotificationsService', () => {
  beforeEach(() => sendMail.mockClear());

  function makeConfig(smtp: Partial<Record<string, unknown>> = {}) {
    return {
      getOrThrow: jest.fn().mockReturnValue({
        host: '',
        port: 587,
        user: '',
        password: '',
        from: 'noreply@example.com',
        secure: false,
        ...smtp,
      }),
    };
  }

  it('does nothing when SMTP_HOST is unset — never throws', async () => {
    const service = new NotificationsService(makeConfig() as any);

    await expect(
      service.sendExtractionComplete('user@example.com', {
        jobId: 'job-1',
        type: 'LEDGERS',
        status: 'SUCCESS',
        recordCount: 5,
      }),
    ).resolves.toBeUndefined();

    expect(sendMail).not.toHaveBeenCalled();
  });

  it('sends a success email with the record count when SMTP is configured', async () => {
    const service = new NotificationsService(makeConfig({ host: 'smtp.example.com' }) as any);

    await service.sendExtractionComplete('user@example.com', {
      jobId: 'job-1',
      type: 'LEDGERS',
      status: 'SUCCESS',
      recordCount: 5,
    });

    expect(sendMail).toHaveBeenCalledTimes(1);
    const call = sendMail.mock.calls[0][0];
    expect(call.to).toBe('user@example.com');
    expect(call.subject).toContain('LEDGERS');
    expect(call.text).toContain('5');
  });

  it('sends a failure email including the error message', async () => {
    const service = new NotificationsService(makeConfig({ host: 'smtp.example.com' }) as any);

    await service.sendExtractionComplete('user@example.com', {
      jobId: 'job-1',
      type: 'VOUCHERS',
      status: 'FAILED',
      error: 'Could not reach Tally',
    });

    const call = sendMail.mock.calls[0][0];
    expect(call.subject).toContain('failed');
    expect(call.text).toContain('Could not reach Tally');
  });

  it('never throws even if the SMTP send itself fails', async () => {
    sendMail.mockRejectedValueOnce(new Error('connection refused'));
    const service = new NotificationsService(makeConfig({ host: 'smtp.example.com' }) as any);

    await expect(
      service.sendExtractionComplete('user@example.com', {
        jobId: 'job-1',
        type: 'LEDGERS',
        status: 'SUCCESS',
        recordCount: 1,
      }),
    ).resolves.toBeUndefined();
  });

  describe('sendPasswordResetOtp', () => {
    it('logs the code at warn level (not silently, unlike sendExtractionComplete) when SMTP is unset — the only way to see a non-fixed code locally', async () => {
      const service = new NotificationsService(makeConfig() as any);
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

      await service.sendPasswordResetOtp('user@example.com', '4821');

      expect(sendMail).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('4821'));
    });

    it('sends the code by email when SMTP is configured', async () => {
      const service = new NotificationsService(makeConfig({ host: 'smtp.example.com' }) as any);

      await service.sendPasswordResetOtp('user@example.com', '4821');

      expect(sendMail).toHaveBeenCalledTimes(1);
      const call = sendMail.mock.calls[0][0];
      expect(call.to).toBe('user@example.com');
      expect(call.subject).toMatch(/reset/i);
      expect(call.text).toContain('4821');
    });

    it('never throws even if the SMTP send itself fails', async () => {
      sendMail.mockRejectedValueOnce(new Error('connection refused'));
      const service = new NotificationsService(makeConfig({ host: 'smtp.example.com' }) as any);

      await expect(service.sendPasswordResetOtp('user@example.com', '4821')).resolves.toBeUndefined();
    });
  });

  describe('sendConnectorToken', () => {
    const info = {
      label: 'Accounts PC',
      defaultCompany: 'ABC Ltd',
      token: 'conn-id.secret',
      connectionId: 'conn-id',
    };

    it('logs at debug level (not warn — the token is always visible elsewhere too) when SMTP is unset', async () => {
      const service = new NotificationsService(makeConfig() as any);
      const debugSpy = jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);

      await service.sendConnectorToken('user@example.com', info);

      expect(sendMail).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalled();
    });

    it('sends the token and connection details by email when SMTP is configured', async () => {
      const service = new NotificationsService(makeConfig({ host: 'smtp.example.com' }) as any);

      await service.sendConnectorToken('user@example.com', info);

      expect(sendMail).toHaveBeenCalledTimes(1);
      const call = sendMail.mock.calls[0][0];
      expect(call.to).toBe('user@example.com');
      expect(call.subject).toContain('Accounts PC');
      expect(call.text).toContain('conn-id.secret');
      expect(call.text).toContain('ABC Ltd');
    });

    it('still mentions the connection when no company is pinned', async () => {
      const service = new NotificationsService(makeConfig({ host: 'smtp.example.com' }) as any);

      await service.sendConnectorToken('user@example.com', { ...info, defaultCompany: null });

      const call = sendMail.mock.calls[0][0];
      expect(call.text).toContain('not pinned to a company');
    });

    it('never throws even if the SMTP send itself fails', async () => {
      sendMail.mockRejectedValueOnce(new Error('connection refused'));
      const service = new NotificationsService(makeConfig({ host: 'smtp.example.com' }) as any);

      await expect(service.sendConnectorToken('user@example.com', info)).resolves.toBeUndefined();
    });
  });
});
