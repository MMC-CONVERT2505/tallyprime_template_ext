import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { TallyException } from '../../tally/exceptions/tally.exceptions';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  hint?: string;
  path: string;
  timestamp: string;
}

/**
 * Single, consistent error envelope for every failure. Crucially, it preserves
 * the actionable `hint` carried by Tally exceptions, so an API consumer sees
 * "Tally unreachable — is 'Act as Server' enabled?" rather than a bare 502.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string | string[] = 'Internal server error';
    let error = 'InternalServerError';
    let hint: string | undefined;

    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (res && typeof res === 'object') {
        const r = res as Record<string, unknown>;
        message = (r.message as string | string[]) ?? exception.message;
        error = (r.error as string) ?? exception.name;
        hint = r.hint as string | undefined;
      }
    }

    if (exception instanceof TallyException) {
      hint = exception.hint ?? hint;
    }

    const body: ErrorBody = {
      statusCode: status,
      error,
      message,
      ...(hint ? { hint } : {}),
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    // Log 5xx (and Tally upstream failures) at error level with the cause;
    // ordinary 4xx validation noise stays at debug.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR || status === HttpStatus.BAD_GATEWAY) {
      const cause = exception instanceof TallyException ? exception.originalCause : exception;
      this.logger.error(
        `${request.method} ${request.url} -> ${status}: ${JSON.stringify(message)}`,
        cause instanceof Error ? cause.stack : undefined,
      );
    } else {
      this.logger.debug(
        `${request.method} ${request.url} -> ${status}: ${JSON.stringify(message)}`,
      );
    }

    response.status(status).json(body);
  }
}
