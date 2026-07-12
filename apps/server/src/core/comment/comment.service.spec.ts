import { CommentService } from './comment.service';

describe('CommentService', () => {
  let service: CommentService;
  const dependency = {} as never;

  beforeEach(() => {
    service = new CommentService(
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
    );
  });

  it('should be defined', () => {
    expect(service).toBeInstanceOf(CommentService);
  });
});
