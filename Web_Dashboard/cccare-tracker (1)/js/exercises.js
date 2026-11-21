/* Exercises, the form faults the camera pipeline can report for each one, and the sample
   workouts every participant starts with.
   The pipeline sends a fault code (for example "knees_in"). The dashboard shows the
   message, and the patient's screen also shows the cue. Codes that aren't listed here are
   shown as plain text. */
(function () {
  'use strict';
  const CC = (window.CC = window.CC || {});

  CC.EXERCISES = {
    sit_to_stand: {
      name: 'Sit-to-stand',
      faults: {
        knees_in: { message: 'Knees caving inward on the way up', cue: 'Keep your knees in line with your toes.' },
        lean_forward: { message: 'Leaning too far forward', cue: 'Lift your chest as you stand.' },
        half_stand: { message: 'Not standing all the way up', cue: 'Stand all the way up before you sit back down.' },
        arm_push: { message: 'Pushing off the thighs with the hands', cue: 'Cross your arms over your chest if you can.' },
        drop_sit: { message: 'Dropping into the chair', cue: 'Sit down slowly, over about three seconds.' },
      },
    },
    mini_squat: {
      name: 'Mini squat',
      faults: {
        knees_in: { message: 'Knees caving inward', cue: 'Push your knees out over your toes.' },
        heels_up: { message: 'Heels lifting off the floor', cue: 'Keep your weight back through your heels.' },
        back_round: { message: 'Back rounding forward', cue: 'Keep your back straight and your chest up.' },
        shallow: { message: 'Not bending far enough', cue: 'Bend a little deeper, as far as is comfortable.' },
      },
    },
    wall_pushup: {
      name: 'Wall push-up',
      faults: {
        hips_sag: { message: 'Hips sagging toward the wall', cue: 'Keep a straight line from your head to your heels.' },
        elbows_flare: { message: 'Elbows flaring out wide', cue: 'Keep your elbows angled back, close to your body.' },
        short_range: { message: 'Elbows not bending enough', cue: 'Bring your chest closer to the wall.' },
        head_drop: { message: 'Head dropping forward', cue: 'Keep your head in line with your body.' },
      },
    },
    bicep_curl: {
      name: 'Bicep curl',
      faults: {
        swing: { message: 'Swinging the body to lift the weight', cue: 'Keep your body still and let your arms do the work.' },
        elbow_drift: { message: 'Elbows drifting forward', cue: 'Keep your elbows by your sides.' },
        short_range: { message: 'Arms not straightening at the bottom', cue: 'Lower the weight all the way down.' },
        too_fast: { message: 'Lifting too fast', cue: 'Slow down. Two seconds up, two seconds down.' },
      },
    },
    arm_raise: {
      name: 'Front arm raise',
      faults: {
        shrug: { message: 'Shoulders shrugging toward the ears', cue: 'Relax your shoulders down.' },
        low_raise: { message: 'Arms not reaching shoulder height', cue: 'Lift to shoulder height if you can.' },
        bent_elbows: { message: 'Elbows bending during the lift', cue: 'Keep your arms long, with a soft elbow.' },
        lean_back: { message: 'Leaning back', cue: 'Stand tall and keep your ribs down.' },
      },
    },
    heel_raise: {
      name: 'Heel raise',
      faults: {
        low_rise: { message: 'Heels not lifting fully', cue: 'Rise as high onto your toes as you can.' },
        lean_forward: { message: 'Leaning forward', cue: 'Keep your body upright.' },
        sway: { message: 'Swaying side to side', cue: 'Hold the chair back lightly for balance.' },
        drop: { message: 'Dropping the heels quickly', cue: 'Lower your heels slowly.' },
      },
    },
  };

  // Standard strength, core and cardio exercises, for sports workouts and for patients
  // who have largely recovered. unit 'seconds' means the "reps" of a set are seconds held
  // (the camera pipeline sends one rep event per second). tempo is the usual seconds per
  // rep, used by the simulator. defaults are the sets and reps added from the library.
  Object.assign(CC.EXERCISES, {
    squat: {
      name: 'Squat',
      defaults: { sets: 3, reps: 12 },
      faults: {
        knees_in: { message: 'Knees caving inward', cue: 'Push your knees out over your toes.' },
        heels_up: { message: 'Heels lifting off the floor', cue: 'Sit back and keep your heels down.' },
        shallow: { message: 'Not squatting deep enough', cue: 'Lower until your thighs are about level with the floor.' },
        back_round: { message: 'Back rounding', cue: 'Keep your chest up and your back flat.' },
      },
    },
    lunge: {
      name: 'Lunge',
      defaults: { sets: 3, reps: 10 },
      faults: {
        knee_past_toe: { message: 'Front knee going past the toes', cue: 'Take a longer step and drop straight down.' },
        knee_in: { message: 'Front knee caving inward', cue: 'Keep your front knee over your middle toes.' },
        torso_lean: { message: 'Leaning forward', cue: 'Keep your body upright as you lower.' },
        shallow: { message: 'Not lowering far enough', cue: 'Lower until your back knee is close to the floor.' },
      },
    },
    push_up: {
      name: 'Push-up',
      defaults: { sets: 3, reps: 10 },
      faults: {
        hips_sag: { message: 'Hips sagging', cue: 'Squeeze your glutes and keep your body in one straight line.' },
        hips_high: { message: 'Hips too high', cue: 'Lower your hips into line with your shoulders and heels.' },
        elbows_flare: { message: 'Elbows flaring out wide', cue: 'Tuck your elbows to about 45 degrees from your body.' },
        short_range: { message: 'Not lowering far enough', cue: 'Lower your chest to just above the floor.' },
      },
    },
    romanian_deadlift: {
      name: 'Romanian deadlift',
      defaults: { sets: 3, reps: 10 },
      faults: {
        back_round: { message: 'Back rounding', cue: 'Keep your back flat and push your hips back.' },
        knees_bend: { message: 'Bending the knees too much', cue: 'Keep a slight bend in the knees and hinge at the hips.' },
        weights_drift: { message: 'Weights drifting away from the legs', cue: 'Keep the dumbbells close to your legs.' },
        short_range: { message: 'Not hinging far enough', cue: 'Lower until you feel a stretch in the back of your thighs.' },
      },
    },
    bent_over_row: {
      name: 'Bent-over row',
      defaults: { sets: 3, reps: 10 },
      faults: {
        back_round: { message: 'Back rounding', cue: 'Keep your back flat and your chest proud.' },
        torso_rise: { message: 'Standing up during the pull', cue: 'Stay bent over and keep your body still.' },
        short_range: { message: 'Elbows not pulling back far enough', cue: 'Pull your elbows back past your body.' },
        jerk: { message: 'Jerking the weight up', cue: 'Pull smoothly and squeeze your shoulder blades.' },
      },
    },
    shoulder_press: {
      name: 'Shoulder press',
      defaults: { sets: 3, reps: 10 },
      faults: {
        back_arch: { message: 'Arching the lower back', cue: 'Brace your stomach and keep your ribs down.' },
        short_range: { message: 'Arms not straightening overhead', cue: 'Press all the way up until your arms are straight.' },
        uneven: { message: 'One arm higher than the other', cue: 'Press both arms up together.' },
        shrug: { message: 'Shoulders shrugging up', cue: 'Keep your shoulders down away from your ears.' },
      },
    },
    tricep_extension: {
      name: 'Overhead tricep extension',
      defaults: { sets: 3, reps: 12 },
      faults: {
        elbows_flare: { message: 'Elbows flaring out', cue: 'Keep your elbows pointing up, close to your head.' },
        back_arch: { message: 'Arching the lower back', cue: 'Brace your stomach and stand tall.' },
        short_range: { message: 'Not lowering far enough', cue: 'Lower the weights behind your head.' },
        upper_arm_moves: { message: 'Upper arms moving', cue: 'Only your forearms should move.' },
      },
    },
    glute_bridge: {
      name: 'Glute bridge',
      defaults: { sets: 3, reps: 12 },
      faults: {
        low_hips: { message: 'Hips not lifting high enough', cue: 'Push through your heels until your body is straight from knees to shoulders.' },
        back_arch: { message: 'Arching the lower back', cue: 'Squeeze your glutes rather than arching your back.' },
        knees_in: { message: 'Knees falling inward', cue: 'Keep your knees hip-width apart.' },
        too_fast: { message: 'Lowering too fast', cue: 'Pause at the top, then lower slowly.' },
      },
    },
    superman: {
      name: 'Superman',
      defaults: { sets: 3, reps: 10 },
      faults: {
        low_lift: { message: 'Arms and legs not lifting', cue: 'Lift your arms and legs a few centimetres off the floor.' },
        neck_crane: { message: 'Looking up', cue: 'Keep your eyes on the floor and your neck long.' },
        bent_knees: { message: 'Knees bending', cue: 'Keep your legs long and straight.' },
        too_fast: { message: 'Moving too fast', cue: 'Hold the top for a second, then lower slowly.' },
      },
    },
    plank: {
      name: 'Plank',
      unit: 'seconds',
      tempo: 1,
      defaults: { sets: 3, reps: 30 },
      faults: {
        hips_sag: { message: 'Hips sagging', cue: 'Squeeze your glutes and tighten your stomach.' },
        hips_high: { message: 'Hips too high', cue: 'Lower your hips into line with your shoulders.' },
        head_drop: { message: 'Head dropping', cue: 'Look at the floor just ahead of your hands.' },
        shaking: { message: 'Shaking a lot', cue: 'Drop to your knees if you need to and keep the hold.' },
      },
    },
    crunch: {
      name: 'Crunch',
      defaults: { sets: 3, reps: 15 },
      faults: {
        neck_pull: { message: 'Pulling on the neck', cue: 'Lead with your chest, not your head.' },
        too_high: { message: 'Sitting all the way up', cue: 'Lift only your shoulders off the floor.' },
        feet_lift: { message: 'Feet lifting', cue: 'Keep your feet flat on the floor.' },
        too_fast: { message: 'Moving too fast', cue: 'Lift for one second and lower for two.' },
      },
    },
    bird_dog: {
      name: 'Bird dog',
      defaults: { sets: 3, reps: 10 },
      faults: {
        hips_rotate: { message: 'Hips twisting', cue: 'Keep your hips level, as if balancing a cup on your back.' },
        back_arch: { message: 'Arching the back', cue: 'Reach long rather than high.' },
        low_reach: { message: 'Arm and leg not reaching out', cue: 'Reach your arm and leg out until they are level with your back.' },
        too_fast: { message: 'Moving too fast', cue: 'Hold for two seconds at full reach.' },
      },
    },
    jumping_jacks: {
      name: 'Jumping jacks',
      tempo: 1,
      defaults: { sets: 3, reps: 30 },
      faults: {
        low_arms: { message: 'Arms not reaching overhead', cue: 'Bring your hands together above your head.' },
        narrow: { message: 'Feet not jumping wide', cue: 'Jump your feet out wider than your shoulders.' },
        heavy_landing: { message: 'Landing heavily', cue: 'Land softly on the balls of your feet.' },
      },
    },
    high_knees: {
      name: 'High knees',
      tempo: 0.7,
      defaults: { sets: 3, reps: 30 },
      faults: {
        low_knees: { message: 'Knees not coming up high', cue: 'Drive your knees up to hip height.' },
        lean_back: { message: 'Leaning back', cue: 'Stay tall and lean very slightly forward.' },
        heavy_landing: { message: 'Landing on the heels', cue: 'Stay light on the balls of your feet.' },
      },
    },
    mountain_climbers: {
      name: 'Mountain climbers',
      tempo: 0.8,
      defaults: { sets: 3, reps: 20 },
      faults: {
        hips_high: { message: 'Hips too high', cue: 'Keep your hips level with your shoulders.' },
        hips_sag: { message: 'Hips sagging', cue: 'Tighten your stomach to hold a straight line.' },
        short_knees: { message: 'Knees not coming in far enough', cue: 'Drive each knee towards your chest.' },
        hands_forward: { message: 'Hands too far forward', cue: 'Keep your hands under your shoulders.' },
      },
    },
    jump_squat: {
      name: 'Jump squat',
      tempo: 2,
      defaults: { sets: 3, reps: 10 },
      faults: {
        knees_in: { message: 'Knees caving inward', cue: 'Push your knees out as you land.' },
        stiff_landing: { message: 'Landing with straight legs', cue: 'Land softly and sink straight into the next squat.' },
        shallow: { message: 'Not squatting deep enough', cue: 'Squat down before you jump.' },
      },
    },
  });

  // Faults any exercise can report.
  const GENERIC = {
    too_fast: { message: 'Moving too fast', cue: 'Slow down. Count two seconds each way.' },
    off_camera: { message: 'Partly out of the camera view', cue: 'Step back into the camera view.' },
  };

  // Sample workouts. Participant 1 gets the first, participant 2 the second, and so on.
  CC.WORKOUTS = [
    [
      { exercise: 'sit_to_stand', sets: 2, reps: 10 },
      { exercise: 'wall_pushup', sets: 2, reps: 8 },
      { exercise: 'heel_raise', sets: 2, reps: 12 },
    ],
    [
      { exercise: 'mini_squat', sets: 2, reps: 10 },
      { exercise: 'bicep_curl', sets: 2, reps: 10 },
      { exercise: 'arm_raise', sets: 2, reps: 8 },
    ],
    [
      { exercise: 'sit_to_stand', sets: 3, reps: 8 },
      { exercise: 'heel_raise', sets: 2, reps: 15 },
    ],
    [
      { exercise: 'wall_pushup', sets: 2, reps: 10 },
      { exercise: 'mini_squat', sets: 2, reps: 12 },
      { exercise: 'bicep_curl', sets: 2, reps: 12 },
    ],
  ];

  // Muscle groups, in the order the exercise library shows them.
  CC.MUSCLE_GROUPS = {
    legs: 'Legs', chest: 'Chest', back: 'Back', arms: 'Arms', shoulders: 'Shoulders', core: 'Core', cardio: 'Cardio',
  };

  // Which group each exercise is listed under, the muscles shown in red in its animation,
  // and the animation itself (drawn by tools/make_exercise_gifs.py).
  const TARGETS = {
    sit_to_stand: { group: 'legs', muscles: ['Quads', 'Glutes'] },
    mini_squat: { group: 'legs', muscles: ['Quads', 'Glutes', 'Hamstrings'] },
    heel_raise: { group: 'legs', muscles: ['Calves'] },
    wall_pushup: { group: 'chest', muscles: ['Chest', 'Triceps'] },
    bicep_curl: { group: 'arms', muscles: ['Biceps'] },
    arm_raise: { group: 'shoulders', muscles: ['Front shoulders'] },
    squat: { group: 'legs', muscles: ['Quads', 'Glutes', 'Hamstrings'] },
    lunge: { group: 'legs', muscles: ['Quads', 'Glutes'] },
    romanian_deadlift: { group: 'legs', muscles: ['Hamstrings', 'Glutes', 'Lower back'] },
    glute_bridge: { group: 'legs', muscles: ['Glutes', 'Hamstrings'] },
    push_up: { group: 'chest', muscles: ['Chest', 'Triceps', 'Shoulders'] },
    bent_over_row: { group: 'back', muscles: ['Lats', 'Biceps'] },
    superman: { group: 'back', muscles: ['Lower back', 'Glutes'] },
    tricep_extension: { group: 'arms', muscles: ['Triceps'] },
    shoulder_press: { group: 'shoulders', muscles: ['Shoulders', 'Triceps'] },
    plank: { group: 'core', muscles: ['Abs'] },
    crunch: { group: 'core', muscles: ['Abs'] },
    bird_dog: { group: 'core', muscles: ['Abs', 'Lower back', 'Glutes'] },
    jumping_jacks: { group: 'cardio', muscles: ['Full body', 'Calves', 'Shoulders'] },
    high_knees: { group: 'cardio', muscles: ['Full body', 'Quads', 'Calves'] },
    mountain_climbers: { group: 'cardio', muscles: ['Full body', 'Abs', 'Shoulders'] },
    jump_squat: { group: 'cardio', muscles: ['Quads', 'Glutes', 'Calves'] },
  };
  for (const [code, t] of Object.entries(TARGETS)) {
    Object.assign(CC.EXERCISES[code], t, { gif: `img/exercises/${code}.gif` });
  }

  // Exercises done on the floor. Being on the floor during these is normal; during any
  // other exercise it may mean a fall (see Tracker.dangers in score.js).
  ['push_up', 'plank', 'crunch', 'glute_bridge', 'superman', 'bird_dog', 'mountain_climbers']
    .forEach((code) => (CC.EXERCISES[code].floor = true));

  // Largest workout the set-up screen allows. Rest is in seconds, after each set.
  CC.WORKOUT_LIMITS = { exercises: 8, sets: 10, reps: 100, restMin: 15, restMax: 300, rest: 45 };

  CC.exerciseName = (code) => (CC.EXERCISES[code] ? CC.EXERCISES[code].name : String(code));

  // Rest after each set of a workout entry, in seconds. Older saved workouts have none.
  CC.restOf = (w) => (w && Number.isFinite(w.rest) ? w.rest : CC.WORKOUT_LIMITS.rest);

  // Held exercises (plank) count seconds instead of reps.
  CC.timed = (code) => !!(CC.EXERCISES[code] && CC.EXERCISES[code].unit === 'seconds');
  // "2×10", or "2×30s" for a held exercise.
  CC.planText = (w) => `${w.sets}×${w.reps}${CC.timed(w.exercise) ? 's' : ''}`;
  // Sets and reps when an exercise is added from the library.
  CC.defaultsFor = (code) => {
    const d = (CC.EXERCISES[code] && CC.EXERCISES[code].defaults) || {};
    return { sets: d.sets || 2, reps: d.reps || 10 };
  };

  // "Sit-to-stand 2×10, Plank 3×30s". With long = true: "Sit-to-stand, 2 sets of 10;
  // plank, 3 sets of 30 seconds".
  CC.describeWorkout = function (workout, long) {
    return workout
      .map((w) => (long
        ? `${CC.exerciseName(w.exercise)}, ${w.sets} ${w.sets === 1 ? 'set' : 'sets'} of ${w.reps}${CC.timed(w.exercise) ? ' seconds' : ''}`
        : `${CC.exerciseName(w.exercise)} ${CC.planText(w)}`))
      .join(long ? '; ' : ', ');
  };

  CC.fault = function (exercise, code) {
    const ex = CC.EXERCISES[exercise];
    const found = (ex && ex.faults[code]) || GENERIC[code];
    if (found) return Object.assign({ code }, found);
    const text = String(code).replace(/_/g, ' ').trim().slice(0, 80);
    return { code, message: text.charAt(0).toUpperCase() + text.slice(1), cue: '' };
  };
})();
