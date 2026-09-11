import {
	assertWire,
	SeatActor,
	type Commit,
	type CommitResponse,
	type LeaseRow,
	type SeatRoom,
	type ViewResponse,
	type Wake,
} from '@ambionframework/ambion/protocol';

void [assertWire, SeatActor];
void ((value: Commit | CommitResponse | LeaseRow | SeatRoom | ViewResponse | Wake) => value);
