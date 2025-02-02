import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, Observable, of } from 'rxjs';
import { take } from 'rxjs/operators';
import { ConfigurationProvider } from '../config/config.provider';
import { LoggerService } from '../logging/logger.service';
import { EventTypes } from '../public-events/event-types';
import { PublicEventsService } from '../public-events/public-events.service';
import { StoragePersistenceService } from '../storage/storage-persistence.service';
import { IFrameService } from './existing-iframe.service';

const IFRAME_FOR_CHECK_SESSION_IDENTIFIER = 'myiFrameForCheckSession';

// http://openid.net/specs/openid-connect-session-1_0-ID4.html

@Injectable()
export class CheckSessionService {
  private checkSessionReceived = false;
  private scheduledHeartBeatRunning: any;
  private lastIFrameRefresh = 0;
  private outstandingMessages = 0;
  private heartBeatInterval = 3000;
  private iframeRefreshInterval = 60000;
  private checkSessionChangedInternal$ = new BehaviorSubject<boolean>(false);

  get checkSessionChanged$() {
    return this.checkSessionChangedInternal$.asObservable();
  }

  constructor(
    private storagePersistenceService: StoragePersistenceService,
    private loggerService: LoggerService,
    private iFrameService: IFrameService,
    private eventService: PublicEventsService,
    private configurationProvider: ConfigurationProvider,
    private zone: NgZone
  ) {}

  isCheckSessionConfigured() {
    const { startCheckSession } = this.configurationProvider.getOpenIDConfiguration();
    return startCheckSession;
  }

  start(): void {
    if (!!this.scheduledHeartBeatRunning) {
      return;
    }

    const { clientId } = this.configurationProvider.getOpenIDConfiguration();
    this.pollServerSession(clientId);
  }

  stop(): void {
    if (!this.scheduledHeartBeatRunning) {
      return;
    }

    this.clearScheduledHeartBeat();
    this.checkSessionReceived = false;
  }

  serverStateChanged() {
    const { startCheckSession } = this.configurationProvider.getOpenIDConfiguration();
    return startCheckSession && this.checkSessionReceived;
  }

  getExistingIframe() {
    return this.iFrameService.getExistingIFrame(IFRAME_FOR_CHECK_SESSION_IDENTIFIER);
  }

  private init(): Observable<any> {
    if (this.lastIFrameRefresh + this.iframeRefreshInterval > Date.now()) {
      return of(undefined);
    }

    const authWellKnownEndPoints = this.storagePersistenceService.read('authWellKnownEndPoints');

    if (!authWellKnownEndPoints) {
      this.loggerService.logWarning('init check session: authWellKnownEndpoints is undefined. Returning.');
      return of();
    }

    const existingIframe = this.getOrCreateIframe();
    const checkSessionIframe = authWellKnownEndPoints.checkSessionIframe;

    if (checkSessionIframe) {
      existingIframe.contentWindow.location.replace(checkSessionIframe);
    } else {
      this.loggerService.logWarning('init check session: checkSessionIframe is not configured to run');
    }

    return new Observable((observer) => {
      existingIframe.onload = () => {
        this.lastIFrameRefresh = Date.now();
        observer.next();
        observer.complete();
      };
    });
  }

  private pollServerSession(clientId: string) {
    this.outstandingMessages = 0;
    const pollServerSessionRecur = () => {
      this.init()
        .pipe(take(1))
        .subscribe(() => {
          const existingIframe = this.getExistingIframe();
          if (existingIframe && clientId) {
            this.loggerService.logDebug(existingIframe);
            const sessionState = this.storagePersistenceService.read('session_state');
            const authWellKnownEndPoints = this.storagePersistenceService.read('authWellKnownEndPoints');

            if (sessionState && authWellKnownEndPoints?.checkSessionIframe) {
              const iframeOrigin = new URL(authWellKnownEndPoints.checkSessionIframe)?.origin;
              this.outstandingMessages++;
              existingIframe.contentWindow.postMessage(clientId + ' ' + sessionState, iframeOrigin);
            } else {
              this.loggerService.logDebug(`OidcSecurityCheckSession pollServerSession session_state is '${sessionState}'`);
              this.loggerService.logDebug(`AuthWellKnownEndPoints is '${JSON.stringify(authWellKnownEndPoints)}'`);
              this.checkSessionChangedInternal$.next(true);
            }
          } else {
            this.loggerService.logWarning('OidcSecurityCheckSession pollServerSession checkSession IFrame does not exist');
            this.loggerService.logDebug(clientId);
            this.loggerService.logDebug(existingIframe);
          }

          // after sending three messages with no response, fail.
          if (this.outstandingMessages > 3) {
            this.loggerService.logError(
              `OidcSecurityCheckSession not receiving check session response messages.
                            Outstanding messages: ${this.outstandingMessages}. Server unreachable?`
            );
          }

          this.zone.runOutsideAngular(() => {
            this.scheduledHeartBeatRunning = setTimeout(() => this.zone.run(pollServerSessionRecur), this.heartBeatInterval);
          });
        });
    };

    pollServerSessionRecur();
  }

  private clearScheduledHeartBeat() {
    clearTimeout(this.scheduledHeartBeatRunning);
    this.scheduledHeartBeatRunning = null;
  }

  private messageHandler(e: any) {
    const existingIFrame = this.getExistingIframe();
    const authWellKnownEndPoints = this.storagePersistenceService.read('authWellKnownEndPoints');
    const startsWith = !!authWellKnownEndPoints?.checkSessionIframe?.startsWith(e.origin);
    this.outstandingMessages = 0;
    if (existingIFrame && startsWith && e.source === existingIFrame.contentWindow) {
      if (e.data === 'error') {
        this.loggerService.logWarning('error from checksession messageHandler');
      } else if (e.data === 'changed') {
        this.loggerService.logDebug(e);
        this.checkSessionReceived = true;
        this.eventService.fireEvent(EventTypes.CheckSessionReceived, e.data);
        this.checkSessionChangedInternal$.next(true);
      } else {
        this.eventService.fireEvent(EventTypes.CheckSessionReceived, e.data);
        this.loggerService.logDebug(e.data + ' from checksession messageHandler');
      }
    }
  }

  private bindMessageEventToIframe() {
    const iframeMessageEvent = this.messageHandler.bind(this);
    window.addEventListener('message', iframeMessageEvent, false);
  }

  private getOrCreateIframe() {
    const existingIframe = this.getExistingIframe();

    if (!existingIframe) {
      const frame = this.iFrameService.addIFrameToWindowBody(IFRAME_FOR_CHECK_SESSION_IDENTIFIER);
      this.bindMessageEventToIframe();
      return frame;
    }

    return existingIframe;
  }
}
