import { WorkspaceService } from './workspace.service';

describe('WorkspaceService', () => {
  let service: WorkspaceService;
  const dependency = {} as never;

  beforeEach(() => {
    service = new WorkspaceService(
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
    );
  });

  it('should be defined', () => {
    expect(service).toBeInstanceOf(WorkspaceService);
  });
});
