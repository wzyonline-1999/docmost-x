import { Injectable } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

@Injectable()
export class BaseRealtimeBridge {
  setServer(_server: Server): void {
    return;
  }

  isBaseEvent(_data: any): boolean {
    return false;
  }

  async handleInbound(_client: Socket, _data: any): Promise<void> {
    return;
  }

  async handleDisconnect(_client: Socket): Promise<void> {
    return;
  }
}
