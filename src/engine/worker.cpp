#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

// Persistent newline-delimited worker. Each request is:
// requestId<TAB>count<TAB>affinity,freshness,engagement,completion,negative ...
// Response: requestId<TAB>comma-separated sorted input indexes
struct Candidate {
  double affinity, freshness, engagement, completion, negative;
  double score;
  std::size_t index;
};

static std::vector<std::string> split(const std::string& value, char delimiter) {
  std::vector<std::string> parts;
  std::stringstream stream(value);
  std::string part;
  while (std::getline(stream, part, delimiter)) parts.push_back(part);
  return parts;
}

static double clamp01(double value) { return std::max(0.0, std::min(1.0, value)); }

int main() {
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);
  std::string line;
  while (std::getline(std::cin, line)) {
    try {
      const auto fields = split(line, '\t');
      if (fields.size() < 2) continue;
      const std::string requestId = fields[0];
      const auto requested = static_cast<std::size_t>(std::stoul(fields[1]));
      if (requested > 500 || fields.size() != requested + 2) {
        std::cout << requestId << "\tERROR:invalid_candidate_count" << std::endl;
        continue;
      }
      std::vector<Candidate> candidates;
      candidates.reserve(requested);
      for (std::size_t i = 0; i < requested; ++i) {
        const auto values = split(fields[i + 2], ',');
        if (values.size() != 5) throw std::runtime_error("invalid feature tuple");
        Candidate c{};
        c.affinity = clamp01(std::stod(values[0]));
        c.freshness = clamp01(std::stod(values[1]));
        c.engagement = clamp01(std::stod(values[2]));
        c.completion = clamp01(std::stod(values[3]));
        c.negative = clamp01(std::stod(values[4]));
        c.index = i;
        // Transparent baseline ranking model. Tune weights only with measured
        // offline evaluation and opt-in personalization signals.
        c.score = 0.36 * c.affinity + 0.22 * c.freshness +
                  0.18 * c.engagement + 0.16 * c.completion -
                  0.28 * c.negative;
        candidates.push_back(c);
      }
      std::stable_sort(candidates.begin(), candidates.end(), [](const Candidate& a, const Candidate& b) {
        return a.score > b.score;
      });
      std::cout << requestId << '\t';
      for (std::size_t i = 0; i < candidates.size(); ++i) {
        if (i) std::cout << ',';
        std::cout << candidates[i].index;
      }
      std::cout << std::endl;
    } catch (...) {
      const auto separator = line.find('\t');
      const std::string requestId = separator == std::string::npos ? "0" : line.substr(0, separator);
      std::cout << requestId << "\tERROR:invalid_request" << std::endl;
    }
  }
  return 0;
}