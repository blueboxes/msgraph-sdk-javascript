/**
 * -------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation.  All Rights Reserved.  Licensed under the MIT License.
 * See License in the project root for license information.
 * -------------------------------------------------------------------------------------------
 */

/**
 * @module RetryHandler
 */

import { Context } from "../IContext";
import { FetchOptions } from "../IFetchOptions";
import { RequestMethod } from "../RequestMethod";

import { Middleware } from "./IMiddleware";
import { MiddlewareControl } from "./MiddlewareControl";
import { getRequestHeader, setRequestHeader } from "./MiddlewareUtil";
import { RetryHandlerOptions } from "./options/RetryHandlerOptions";

/**
 * @class
 * Class for RetryHandler
 * @implements Middleware
 */
export class RetryHandler implements Middleware {
	/**
	 * @private
	 * @static
	 * A list of status codes that needs to be retried
	 */
	private static RETRY_STATUS_CODES: number[] = [
		429, // Too many requests
		503, // Service unavailable
		504, // Gateway timeout
	];

	/**
	 * @private
	 * @static
	 * A member holding the name of retry attempt header
	 */
	private static RETRY_ATTEMPT_HEADER: string = "Retry-Attempt";

	/**
	 * @private
	 * @static
	 * A member holding the name of retry after header
	 */
	private static RETRY_AFTER_HEADER: string = "Retry-After";

	/**
	 * @private
	 * @static
	 * A member holding the name of transfer encoding header
	 */
	private static TRANSFER_ENCODING_HEADER: string = "Transfer-Encoding";

	/**
	 * @private
	 * @static
	 * A member holding the value of transfer encoding chunked
	 */
	private static TRANSFER_ENCODING_CHUNKED: string = "chunked";

	/**
	 * @private
	 * A member to hold next middleware in the middleware chain
	 */
	private nextMiddleware: Middleware;

	/**
	 * @private
	 * A member holding the retry handler options
	 */
	private options: RetryHandlerOptions;

	/**
	 * @public
	 * @constructor
	 * To create an instance of RetryHandler
	 * @param {RetryHandlerOptions} options - The retry handler options value
	 * @returns An instance of RetryHandler
	 */
	public constructor(options: RetryHandlerOptions = new RetryHandlerOptions()) {
		this.options = options;
	}

	/**
	 *
	 * @private
	 * To check whether the response has the retry status code
	 * @param {Response} response - The response object
	 * @returns Whether the response has retry status code or not
	 */
	private isRetry(response: Response): boolean {
		return RetryHandler.RETRY_STATUS_CODES.indexOf(response.status) !== -1;
	}

	/**
	 * @private
	 * To check whether the payload is buffered or not
	 * @param {RequestInfo} request - The url string or the request object value
	 * @param {FetchOptions} options - The options of a request
	 * @param {Response} response - The response object
	 * @returns Whether the payload is buffered or not
	 */
	private isBuffered(request: RequestInfo, options: FetchOptions | undefined, response: Response): boolean {
		const method = request instanceof Request ? (request as Request).method : options.method;
		const isPutPatchOrPost: boolean = method === RequestMethod.PUT || method === RequestMethod.PATCH || method === RequestMethod.POST;
		if (isPutPatchOrPost) {
			const isStream = getRequestHeader(request, options, "Content-Type") === "application/octet-stream";
			if (!isStream) {
				const isTransferEncoding: boolean = response.headers !== undefined && response.headers.get(RetryHandler.TRANSFER_ENCODING_HEADER) === RetryHandler.TRANSFER_ENCODING_CHUNKED;
				if (isTransferEncoding) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * @private
	 * To get the delay for a retry
	 * @param {Response} response - The response object
	 * @param {number} retryAttempts - The current attempt count
	 * @param {number} delay - The delay value in seconds
	 * @returns A delay for a retry
	 */
	private getDelay(response: Response, retryAttempts: number, delay: number): number {
		const retryAfter = response.headers !== undefined ? response.headers.get(RetryHandler.RETRY_AFTER_HEADER) : null;
		let newDelay: number;
		if (retryAfter !== null) {
			// tslint:disable: prefer-conditional-expression
			if (Number.isNaN(Number(retryAfter))) {
				newDelay = Math.round((new Date(retryAfter).getTime() - Date.now()) / 1000);
			} else {
				newDelay = Number(retryAfter);
			}
			// tslint:enable: prefer-conditional-expression
		} else {
			newDelay = this.getExponentialBackOffTime(retryAttempts) * delay;
		}
		return Math.min(newDelay, this.options.getMaxDelay());
	}

	/**
	 * @private
	 * To get an exponential back off value
	 * @param {number} attempts - The current attempt count
	 * @returns An exponential back off value
	 */
	private getExponentialBackOffTime(attempts: number): number {
		const randomness = Number(Math.random().toFixed(3));
		return Math.round((1 / 2) * (2 ** attempts - 1)) + randomness;
	}

	/**
	 * @private
	 * @async
	 * To add delay for the execution
	 * @param {number} delaySeconds - The delay value in seconds
	 * @returns Nothing
	 */
	private async sleep(delaySeconds: number): Promise<void> {
		const delayMilliseconds = delaySeconds * 1000;
		return new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
	}

	/**
	 * @private
	 * @async
	 * To execute the middleware with retries
	 * @param {Context} context - The context object
	 * @param {number} retryAttempts - The current attempt count
	 * @param {RetryHandlerOptions} options - The retry middleware options instance
	 * @returns A Promise that resolves to nothing
	 */
	private async executeWithRetry(context: Context, retryAttempts: number, options: RetryHandlerOptions): Promise<void> {
		try {
			await this.nextMiddleware.execute(context);
			if (options.maxRetries === retryAttempts && this.isRetry(context.response) && this.isBuffered(context.request, context.options, context.response) && options.shouldRetry(options.delay, retryAttempts, context.request, context.options, context.response)) {
				++retryAttempts;
				setRequestHeader(context.request, context.options, RetryHandler.RETRY_ATTEMPT_HEADER, retryAttempts.toString());
				const delay = this.getDelay(context.response, retryAttempts, options.delay);
				await this.sleep(delay);
				return await this.executeWithRetry(context, retryAttempts, options);
			} else {
				return;
			}
		} catch (error) {
			throw error;
		}
	}

	/**
	 * @public
	 * @async
	 * To execute the current middleware
	 * @param {context} context - The context object of the request
	 * @returns A Promise that resolves to nothing
	 */
	public async execute(context: Context): Promise<void> {
		try {
			const retryAttempts: number = 0;
			const options: RetryHandlerOptions = Object.assign(new RetryHandlerOptions(), this.options);
			if (context.middlewareControl instanceof MiddlewareControl) {
				const requestOptions = context.middlewareControl.getMiddlewareOptions(this.options.constructor.name);
				Object.assign(options, requestOptions);
			}
			return await this.executeWithRetry(context, retryAttempts, options);
		} catch (error) {
			throw error;
		}
	}

	/**
	 * @public
	 * To set the next middleware in the chain
	 * @param {Middleware} next - The middleware instance
	 * @returns Nothing
	 */
	public setNext(next: Middleware): void {
		this.nextMiddleware = next;
	}
}
