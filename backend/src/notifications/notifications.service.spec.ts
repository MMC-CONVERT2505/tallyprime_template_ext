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
});
