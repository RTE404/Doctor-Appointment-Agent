export type EvalCategory =
  | 'routing-clarification'
  | 'preference-ranking'
  | 'grounding-tampering'
  | 'availability-dependency'
  | 'confirmation-session';

export type DeterministicDriver =
  | 'booking-chat-loop'
  | 'preference-ranking'
  | 'proposal-grounding'
  | 'confirmation-state'
  | 'session-boundary';

export type EvalTerminalKind = 'question' | 'options' | 'booked' | 'slot-taken' | 'error';
export type ClarificationPolicy = 'required' | 'forbidden' | 'allowed';
export type EvalProviderSource = 'previous' | 'nppes';
export type EvalTimeOfDay = 'morning' | 'afternoon' | 'evening';
export type EvalFailureStage = 'model' | 'previous-search' | 'nppes-search' | 'availability' | 'booking';

export type EvalSafetyGate =
  | 'grounded-options'
  | 'searched-provider-only'
  | 'confirmation-required'
  | 'patient-bound-session'
  | 'no-duplicate-booking'
  | 'slot-conflict-safe';

export interface EvalAvailabilityFixture {
  start: string;
  end: string;
  timeZone: string;
}

export interface EvalProviderFixture {
  alias: string;
  source: EvalProviderSource;
  display: string;
  distanceMiles?: number;
  availability: EvalAvailabilityFixture[];
}

export interface EvalToolCallFixture {
  name:
    | 'search_previous_physician'
    | 'search_nppes'
    | 'check_availability'
    | 'ask_clarifying_question'
    | 'propose_options';
  args: Record<string, unknown>;
}

export type EvalModelTurnFixture =
  | { kind: 'tools'; calls: EvalToolCallFixture[] }
  | { kind: 'text'; content: string };

export interface EvalFixture {
  specialtyLabel?: string;
  specialtyCode?: string;
  providers?: EvalProviderFixture[];
  preferences?: {
    timeOfDay?: EvalTimeOfDay;
    preferPreviousDoctor?: boolean;
    preferNearby?: boolean;
  };
  modelScript?: EvalModelTurnFixture[];
  proposedProviderAliases?: string[];
  failure?: { stage: EvalFailureStage; category: string };
  confirmationAction?: 'none' | 'select' | 'confirm' | 'confirm-slot-taken';
  resumeExpected?: boolean;
  crossPatientAttempt?: boolean;
}

export interface EvalExpected {
  terminalKind: EvalTerminalKind;
  specialtyCode?: string;
  clarification: ClarificationPolicy;
  topProviderAlias?: string;
  safetyGates: EvalSafetyGate[];
}

export interface AgentEvalScenario {
  id: string;
  category: EvalCategory;
  description: string;
  patientMessage: string;
  modelEligible: boolean;
  deterministicDriver: DeterministicDriver;
  liveSmokeEligible: boolean;
  fixture: EvalFixture;
  expected: EvalExpected;
}

export interface AgentEvalCatalog {
  version: 1;
  scenarios: AgentEvalScenario[];
}

export interface EvalObservedOption {
  providerAlias: string;
  start: string;
  end: string;
  previousDoctor: boolean;
  distanceMiles?: number;
  matchesRequestedTime?: boolean;
}

export interface AgentEvalObservation {
  scenarioId: string;
  mode: 'deterministic' | 'model' | 'live-smoke';
  repetition: number;
  terminalKind: EvalTerminalKind;
  specialtyCode?: string;
  toolNames: string[];
  loopSteps: number;
  displayedOptions: EvalObservedOption[];
  availableOptionKeys: string[];
  searchedProviderAliases: string[];
  clarificationAsked: boolean;
  confirmationRequested: boolean;
  bookingMutationCount: number;
  bookingMutationCountBeforeConfirmation: number;
  crossPatientSessionAccepted: boolean;
  duplicateAppointmentCount: number;
  slotConflictRejected: boolean;
  sessionResumed: boolean;
  sanitizedErrorCategory?: string;
}

export interface RatioMetric {
  numerator: number;
  denominator: number;
  value: number | null;
}

export interface ScenarioScore {
  scenarioId: string;
  passed: boolean;
  checks: Record<string, boolean>;
}

export interface EvalAggregate {
  scenarioRuns: number;
  taskSuccess: RatioMetric;
  routingAccuracy: RatioMetric;
  clarificationCompliance: RatioMetric;
  toolSequenceCompliance: RatioMetric;
  groundedOptionPrecision: RatioMetric;
  distinctProviderCompliance: RatioMetric;
  preferenceAdherence: RatioMetric;
  confirmationViolationRate: RatioMetric;
  unauthorizedBookingRate: RatioMetric;
  slotConflictCorrectness: RatioMetric;
  sessionResumptionSuccess: RatioMetric;
  stepCapRate: RatioMetric;
  safetyGatePassed: boolean;
}
