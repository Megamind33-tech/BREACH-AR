using System;

namespace Breach.Core.Diagnostics
{
    /// <summary>Rolling frame-time statistics (average FPS, 1% low, worst frame).</summary>
    public sealed class FrameStats
    {
        readonly float[] _samples;
        int _count;
        int _head;

        public FrameStats(int capacity = 600)
        {
            _samples = new float[Math.Max(8, capacity)];
        }

        public int Count => _count;

        public void Add(float dt)
        {
            if (dt <= 0f || float.IsNaN(dt)) return;
            _samples[_head] = dt;
            _head = (_head + 1) % _samples.Length;
            if (_count < _samples.Length) _count++;
        }

        public float AverageFps
        {
            get
            {
                if (_count == 0) return 0f;
                double sum = 0;
                for (int i = 0; i < _count; i++) sum += _samples[i];
                return (float)(_count / sum);
            }
        }

        public float WorstFrameMs
        {
            get
            {
                float worst = 0f;
                for (int i = 0; i < _count; i++) worst = MathF.Max(worst, _samples[i]);
                return worst * 1000f;
            }
        }

        /// <summary>FPS of the slowest 1% of frames.</summary>
        public float OnePercentLowFps
        {
            get
            {
                if (_count == 0) return 0f;
                var copy = new float[_count];
                Array.Copy(_samples, copy, _count);
                Array.Sort(copy);
                int n = Math.Max(1, _count / 100);
                double sum = 0;
                for (int i = _count - n; i < _count; i++) sum += copy[i];
                return (float)(n / sum);
            }
        }
    }
}
