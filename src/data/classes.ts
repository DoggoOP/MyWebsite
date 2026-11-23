export const AXES = ['Math', 'CS', 'Aero', 'Mechanics + physics', 'Humanities'] as const;

export type ClassRow = {
  code: string;
  title: string;
  units: number;
  weights: [number, number, number, number, number];
  now?: boolean;
};

// Weights follow AXES order. `now: true` marks this quarter (drawn as a ring).
export const CLASSES: ClassRow[] = [
  { code: 'COLLEGE 101', title: 'Why College? Your Education and the Good Life', units: 3, weights: [0, 0, 0, 0, 1] },
  { code: 'PWR 1HK', title: 'Writing and Rhetoric: Food', units: 4, weights: [0, 0, 0, 0, 1] },
  { code: 'ENGR 15', title: 'Dynamics', units: 3, weights: [0.1, 0, 0.3, 0.6, 0] },
  { code: 'MATH 51', title: 'Linear Algebra and Differential Calculus of Several Variables', units: 5, weights: [1, 0, 0, 0, 0] },
  { code: 'COLLEGE 102', title: 'Citizenship in the 21st Century', units: 3, weights: [0, 0, 0, 0, 1] },
  { code: 'CS 106B', title: 'Programming Abstractions', units: 5, weights: [0, 1, 0, 0, 0] },
  { code: 'PHYSICS 45', title: 'Light and Heat', units: 4, weights: [0.15, 0, 0, 0.85, 0] },
  { code: 'MATH 53', title: 'Differential Equations with Linear Algebra and Fourier Methods', units: 5, weights: [0.85, 0, 0, 0.15, 0] },
  { code: 'AA 199', title: 'Directed Research', units: 3, weights: [0, 0, 0.7, 0.3, 0] },
  { code: 'AA 174A', title: 'Principles of Robot Autonomy I', units: 4, weights: [0.2, 0.45, 0.35, 0, 0] },
  { code: 'ME 30', title: 'Engineering Thermodynamics', units: 3, weights: [0, 0, 0.2, 0.8, 0] },
  { code: 'BUSGEN 112', title: 'Financial Acumen and Effective Communication', units: 3, weights: [0.15, 0, 0, 0, 0.85] },
  { code: 'AA 100', title: 'Introduction to Aeronautics and Astronautics', units: 3, weights: [0, 0, 1, 0, 0] },
  { code: 'ENGR 14', title: 'Intro to Solid Mechanics', units: 4, weights: [0, 0, 0.25, 0.75, 0] },
  { code: 'AA 141', title: 'Atmospheric Flight', units: 3, weights: [0, 0, 0.85, 0.15, 0] },
  { code: 'CS 103', title: 'Mathematical Foundations of Computing', units: 5, weights: [0.4, 0.6, 0, 0, 0], now: true },
  { code: 'STATS 117', title: 'Introduction to Probability Theory', units: 4, weights: [0.9, 0.1, 0, 0, 0], now: true },
  { code: 'AA 151', title: 'Lightweight Structures', units: 3, weights: [0, 0, 0.5, 0.5, 0], now: true },
  { code: 'ENGR 76', title: 'Information Science and Engineering', units: 5, weights: [0.3, 0.55, 0, 0.15, 0], now: true },
  { code: 'ENGR 319', title: 'Robotics and Autonomous Systems Seminar', units: 1, weights: [0, 0.5, 0.5, 0, 0], now: true },
];
